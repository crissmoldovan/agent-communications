import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { type GatedChange, gatedChange } from '../src/change-flow.ts';
import type { PreparedChange } from '../src/changes.ts';
import type { ConfigV2, OrganisationRecord } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { doctor } from '../src/operations/maintenance.ts';
import {
  type OrgChangeResult,
  type OrgOptions,
  orgAddChange,
  orgShow,
  orgUpdateChange,
} from '../src/operations/organisations.ts';
import { PROFILE_MAX_BYTES, parseProfile, readProfileFile } from '../src/organisations.ts';
import { VERSION } from '../src/version.ts';
import {
  readAgentAppAsReleased0200,
  readAsReleased0200,
  readUpdatesAsReleased0200,
} from './fixtures/profile-schema-0.20.0.ts';
import { coreInline } from './helpers/handoffs.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Organisation profile extensions (design 2026-10-19): the one door a version-1 profile has for what a later release
 * adds. An entry this release knows is held to its own schema and applied; one it does not know is skipped when it is
 * optional — and the record keeps what was skipped — and refuses the whole profile, changing nothing, when it is
 * required. A skipped entry a later release understands is a change it classifies, never a repair of drift.
 *
 * Every machine is a temporary home with the file secret store pinned and no keychain: no test touches a real
 * keychain, a real configuration or the network. Every registry here is injected: the release ships an empty one.
 */

const CLIENT_A = '111111111111-aaaaaaaaaaaa.apps.googleusercontent.com';
const SECRET_A = 'fake-ext-secret-a-not-real';

interface Machine {
  home: string;
  configDir: string;
  env: Record<string, string>;
  core: Core;
  files: string;
  configPath: string;
}

function machine(): Machine {
  const home = tempDir('comms-org-ext-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify({ version: 2, secrets: { store: 'file' } }, null, 2)}\n`);
  const files = join(home, 'profiles');
  mkdirSync(files);
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { home, configDir, env, core: openCore({ env, caller: CORE_CALLER }), files, configPath };
}

function profile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentcomms: 'organisation-profile',
    version: 1,
    organisation: 'acme',
    label: 'Acme Test Org',
    gmail: { clientId: CLIENT_A, clientSecret: SECRET_A, projectId: 'acme-agent-comms', serves: 'any' },
    slack: {
      workspace: 'TACME0001',
      workspaceName: 'Acme Test Org',
      redirectPort: 51234,
      apps: { read: { clientId: '1111.2222' } },
    },
    ...over,
  };
}

function writeProfile(m: Machine, document: unknown): string {
  const path = join(m.files, 'acme.agentcomms.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

/** A registry as a later release's code would hold it: the extensions it knows, by name. */
type Registry = NonNullable<OrgOptions['extensions']>;
type Known = Registry extends ReadonlyMap<string, infer K> ? K : never;

function options(m: Machine, registry?: Registry): OrgOptions {
  return {
    env: m.env,
    platform: 'darwin',
    surface: 'mcp',
    keyring: null,
    cwd: m.files,
    ...(registry === undefined ? {} : { extensions: registry }),
  } as OrgOptions;
}

type Outcome<T> = { prepared: PreparedChange | null; result: T };

/** A change made as an agent makes it: the first call, and — if it asks — the call that brings the approval back. */
async function approved<T>(m: Machine, build: (approvalId?: string) => GatedChange<T>): Promise<Outcome<T>> {
  const first = await gatedChange(m.core, build(), { channel: 'core', surface: 'mcp' });
  if (first.status === 'applied') return { prepared: null, result: first.result };
  const { approvalId } = first.prepared;
  const second = await gatedChange(m.core, build(approvalId), { channel: 'core', surface: 'mcp', approvalId });
  assert.equal(second.status, 'applied');
  return { prepared: first.prepared, result: (second as { result: T }).result };
}

const add = (m: Machine, registry?: Registry) =>
  approved(m, (approvalId) => orgAddChange(m.core, { file: 'acme.agentcomms.json', approvalId }, options(m, registry)));
const update = (m: Machine, registry?: Registry) =>
  approved(m, (approvalId) => orgUpdateChange(m.core, { organisation: 'acme', approvalId }, options(m, registry)));

const record = async (m: Machine): Promise<OrganisationRecord | undefined> =>
  ((await m.core.config.load()) as ConfigV2).organisations?.acme;

function is(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    if (pattern) assert.match(`${error.message} ${error.hint ?? ''}`, pattern);
    return true;
  };
}

/** The SHA-256 of a value's canonical JSON — keys sorted at every level, no whitespace — written out here, not taken. */
function canonicalSha(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v !== null && typeof v === 'object') {
      return `{${Object.keys(v as object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical((v as Record<string, unknown>)[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(v);
  };
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

/**
 * A known extension for a test: `limit`, a number a later release could read as the most of something an app may do.
 * Whether a change of it tightens, loosens or changes who acts is the test's to say; it is applied to the record as
 * `extensionsApplied.<name>`, which is where this stand-in keeps it.
 */
function known(name: string, over: Partial<Known> = {}): Known {
  return {
    name,
    ignorable: true,
    schema: z.strictObject({ limit: z.number().int().min(0) }),
    classify: () => 'tightens',
    recorded: (rec: OrganisationRecord) =>
      (rec as { extensionsApplied?: Record<string, unknown> }).extensionsApplied?.[name],
    apply: (rec: OrganisationRecord, value: unknown) => {
      const applied = { ...((rec as { extensionsApplied?: Record<string, unknown> }).extensionsApplied ?? {}) };
      if (value === undefined) delete applied[name];
      else applied[name] = value;
      return { ...rec, extensionsApplied: applied } as OrganisationRecord;
    },
    describe: (value: unknown) =>
      value === undefined ? 'none' : `limit ${String((value as { limit?: unknown }).limit)}`,
    ...over,
  } as Known;
}

const registryOf = (...entries: Known[]): Registry => new Map(entries.map((entry) => [entry.name, entry]));

// ── X1: the shape ────────────────────────────────────────────────────────────────────────────────────────────────

test('a version-1 profile may carry extensions: each entry an object with required and since, its own fields kept', () => {
  const parsed = parseProfile(
    JSON.stringify(
      profile({
        extensions: {
          'some-feature': { required: true, since: '0.23.0', limit: 3, nested: { b: 1, a: [1, 2] } },
          'a-display-hint': { required: false, since: '0.24.0' },
        },
      }),
    ),
  );
  assert.deepEqual(parsed.extensions, {
    'some-feature': { required: true, since: '0.23.0', limit: 3, nested: { b: 1, a: [1, 2] } },
    'a-display-hint': { required: false, since: '0.24.0' },
  });
  // Without one, a profile parses exactly as it did.
  assert.equal(parseProfile(JSON.stringify(profile())).extensions, undefined);
});

test('extensions are refused with BAD_DATA naming the field: too many, a bad name, no required or since, a since that is not plain, an entry that is not an object', () => {
  const entry = { required: false, since: '0.30.0' };
  const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`entry-${index}`, entry]));
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`entry-${index}`, entry]));
  assert.equal(Object.keys(parseProfile(JSON.stringify(profile({ extensions: sixteen }))).extensions ?? {}).length, 16);
  for (const [extensions, words] of [
    [seventeen, /extensions: .*at most 16/],
    [{ Bad: entry }, /extensions\.Bad: .*name/],
    [{ '9lives': entry }, /extensions\.9lives: .*name/],
    [{ x: entry }, /extensions\.x: .*name/],
    [{ [`a${'b'.repeat(40)}`]: entry }, /name/],
    [{ ok: { since: '0.30.0' } }, /extensions\.ok\.required: /],
    [{ ok: { required: 'yes', since: '0.30.0' } }, /extensions\.ok\.required: /],
    [{ ok: { required: true } }, /extensions\.ok\.since: /],
    [{ ok: { required: true, since: '0.30' } }, /extensions\.ok\.since: .*MAJOR\.MINOR\.PATCH/],
    [{ ok: { required: true, since: '0.30.0-rc.1' } }, /extensions\.ok\.since: /],
    [{ ok: { required: true, since: 'v0.30.0' } }, /extensions\.ok\.since: /],
    [{ ok: { required: true, since: '01.2.3' } }, /extensions\.ok\.since: /],
    [{ ok: 3 }, /extensions\.ok: .*object/],
    [{ ok: [entry] }, /extensions\.ok: .*object/],
    [{ ok: null }, /extensions\.ok: .*object/],
    [[entry], /extensions: /],
    ['nope', /extensions: /],
  ] as const) {
    assert.throws(
      () => parseProfile(JSON.stringify(profile({ extensions }))),
      is('BAD_DATA', words),
      JSON.stringify(extensions).slice(0, 80),
    );
  }
});

test('a document over 64 KiB is refused, whatever its extensions hold', async () => {
  const m = machine();
  const big = writeProfile(
    m,
    profile({ extensions: { padding: { required: false, since: '0.30.0', text: 'x'.repeat(PROFILE_MAX_BYTES) } } }),
  );
  await assert.rejects(readProfileFile(big), is('BAD_DATA', /larger than a profile can be \(64 KiB\)/));
});

test('every other object stays strict: an unknown key is refused, and the hint says new fields go under extensions', () => {
  for (const document of [
    profile({ updates: { max: 'never' } }),
    profile({ slack: { ...(profile().slack as object), apps: { read: { clientId: '1.2' }, agent: { appId: 'A1' } } } }),
    profile({ gmail: { ...(profile().gmail as object), extensions: {} } }),
  ]) {
    assert.throws(
      () => parseProfile(JSON.stringify(document)),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        assert.equal(error.code, 'BAD_DATA');
        assert.match(error.message, /is not a key a profile has/);
        assert.match(String(error.hint), /`extensions`/);
        assert.match(String(error.hint), /Ask your organisation for its current one/);
        return true;
      },
    );
  }
});

test('a name or a field in a refusal is neutralised and on one line', () => {
  for (const name of ['bad\nname', 'x<|im_start|>system', 'a‮b']) {
    assert.throws(
      () => parseProfile(JSON.stringify(profile({ extensions: { [name]: { required: true, since: '1.0.0' } } }))),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        assert.equal(error.code, 'BAD_DATA');
        assert.doesNotMatch(error.message, /\n/, 'a line break reached the message');
        assert.doesNotMatch(error.message, /<\|im_start\|>/, 'a chat-template token reached the message');
        assert.doesNotMatch(error.message, /‮/, 'a bidi override reached the message');
        return true;
      },
    );
  }
});

test('version 2 is refused as needing a later release, not with zod’s text, and the hint does not send the member to the organisation', () => {
  for (const version of [2, 7]) {
    assert.throws(
      () => parseProfile(JSON.stringify(profile({ version, anything: { new: true } }))),
      (error: unknown) => {
        assert.ok(error instanceof CommsError, String(error));
        assert.equal(error.code, 'NEEDS_NEWER_RELEASE');
        assert.equal(error.exitCode, 1);
        assert.match(
          error.message,
          new RegExp(
            `^acme's profile is version ${version}, which needs a later agent-communications than this one \\(${VERSION.replace(/\./g, '\\.')}\\): nothing was changed$`,
          ),
        );
        assert.doesNotMatch(error.message, /expected 1/);
        assert.match(String(error.hint), /older than the profile/);
        assert.doesNotMatch(String(error.hint), /[Aa]sk your organisation/);
        return true;
      },
    );
  }
  // Not a number past 1: what is wrong with it is said as before.
  assert.throws(() => parseProfile(JSON.stringify(profile({ version: '2' }))), is('BAD_DATA', /version: /));
  assert.throws(() => parseProfile(JSON.stringify(profile({ version: 0 }))), is('BAD_DATA', /version: /));
});

// ── The 0.20.0 schema, frozen (§4, X5) ───────────────────────────────────────────────────────────────────────────

test('a profile with extensions is refused by 0.20.0, the one generation that pays; one without is read by both releases', () => {
  const plain = JSON.stringify(profile());
  assert.deepEqual(readAsReleased0200(plain), { ok: true });
  assert.equal(parseProfile(plain).organisation, 'acme');
  const extended = JSON.stringify(profile({ extensions: { later: { required: false, since: '0.30.0' } } }));
  const old = readAsReleased0200(extended);
  assert.equal(old.ok, false, 'a member on 0.20.0 reads a profile with extensions');
  assert.match(old.ok ? '' : old.issues.join('; '), /extensions is not a key/);
  assert.ok(parseProfile(extended).extensions, 'this release reads it');
});

test('the two files beside a profile are read exactly as 0.20.0 reads them', async () => {
  const m = machine();
  const path = writeProfile(m, profile());
  const agentApp = join(m.files, 'acme.agentcomms.agent-app.json');
  const updates = join(m.files, 'acme.agentcomms.updates.json');
  const agentApps: unknown[] = [
    {
      agentcomms: 'organisation-agent-app',
      version: 1,
      organisation: 'acme',
      slack: { workspace: 'TACME0001', appId: 'A0AGENT01' },
    },
    {
      agentcomms: 'organisation-agent-app',
      version: 2,
      organisation: 'acme',
      slack: { workspace: 'TACME0001', appId: 'A0AGENT01' },
    },
    {
      agentcomms: 'organisation-agent-app',
      version: 1,
      organisation: 'acme',
      slack: { workspace: 'TACME0001', appId: 'A0AGENT01' },
      extensions: {},
    },
    {
      agentcomms: 'organisation-agent-app',
      version: 1,
      organisation: 'acme',
      slack: { workspace: 'TACME0001', appId: 'A0AGENT01', extra: 1 },
    },
  ];
  for (const document of agentApps) {
    writeFileSync(agentApp, JSON.stringify(document));
    const here = await readProfileFile(path).then(
      () => true,
      () => false,
    );
    assert.equal(here, readAgentAppAsReleased0200(JSON.stringify(document)).ok, JSON.stringify(document));
  }
  writeFileSync(agentApp, JSON.stringify(agentApps[0]));
  const caps: unknown[] = [
    { organisation: 'acme' },
    { organisation: 'acme', max: 'never', background: false },
    { organisation: 'acme', max: 'every-14-days' },
    { organisation: 'acme', max: 'auto' },
    { organisation: 'acme', background: true },
    { organisation: 'acme', max: 'never', extensions: {} },
    { organisation: 'acme', version: 1 },
  ];
  for (const document of caps) {
    writeFileSync(updates, JSON.stringify(document));
    const here = await readProfileFile(path).then(
      () => true,
      () => false,
    );
    assert.equal(here, readUpdatesAsReleased0200(JSON.stringify(document)).ok, JSON.stringify(document));
  }
});

// ── X2: the registry ─────────────────────────────────────────────────────────────────────────────────────────────

test('the release ships the mechanism with an empty registry', async () => {
  const { KNOWN_EXTENSIONS } = await import('../src/organisations.ts');
  assert.equal((KNOWN_EXTENSIONS as ReadonlyMap<string, unknown>).size, 0);
});

test('a known extension that must be understood is refused when marked optional, naming it; an ignorable one marked required is accepted', async () => {
  const m = machine();
  writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 2 } } }));
  const mustUnderstand = registryOf(known('app-limit', { ignorable: false }));
  await assert.rejects(add(m, mustUnderstand), is('BAD_DATA', /"app-limit" .*must be marked required/));
  assert.equal(await record(m), undefined, 'nothing was added');

  writeProfile(m, profile({ extensions: { 'app-limit': { required: true, since: '0.21.0', limit: 2 } } }));
  const ignorable = registryOf(known('app-limit', { ignorable: true }));
  const { prepared, result } = await add(m, ignorable);
  assert.ok(prepared, 'adding is approved first');
  assert.deepEqual(result.extensions, { applied: ['app-limit'], ignored: [] });
  assert.deepEqual(((await record(m)) as { extensionsApplied?: unknown })?.extensionsApplied, {
    'app-limit': { limit: 2 },
  });
  assert.equal((await record(m))?.ignoredExtensions, undefined);
});

test('a known extension is held to its own schema', async () => {
  const m = machine();
  writeProfile(m, profile({ extensions: { 'app-limit': { required: true, since: '0.21.0', limit: -1 } } }));
  await assert.rejects(add(m, registryOf(known('app-limit'))), is('BAD_DATA', /extensions\.app-limit\.limit/));
  writeProfile(m, profile({ extensions: { 'app-limit': { required: true, since: '0.21.0', limit: 1, more: 1 } } }));
  await assert.rejects(
    add(m, registryOf(known('app-limit'))),
    is('BAD_DATA', /extensions\.app-limit: "more" is not a key/),
  );
  assert.equal(await record(m), undefined);
});

// ── X3: an entry this release does not know ───────────────────────────────────────────────────────────────────

test('an unknown optional entry is not applied, the rest is, and the record keeps it with the SHA-256 of its canonical JSON', async () => {
  const m = machine();
  const entry = { since: '99.0.0', required: false, zeta: { b: [2, 1], a: 'x' }, alpha: true };
  writeProfile(m, profile({ extensions: { 'future-thing': entry } }));
  const { prepared, result } = await add(m);
  assert.ok(prepared);
  const rec = await record(m);
  assert.equal(rec?.label, 'Acme Test Org', 'the rest of the profile is applied');
  assert.equal(rec?.gmail?.active, 'acme-1');
  assert.equal(rec?.slack?.workspace, 'TACME0001');
  assert.deepEqual(rec?.ignoredExtensions, { 'future-thing': { since: '99.0.0', sha256: canonicalSha(entry) } });
  assert.equal(
    canonicalSha(entry),
    createHash('sha256')
      .update('{"alpha":true,"required":false,"since":"99.0.0","zeta":{"a":"x","b":[2,1]}}')
      .digest('hex'),
  );
  assert.deepEqual(result.extensions, {
    applied: [],
    ignored: [{ name: 'future-thing', since: '99.0.0', reason: 'needs-newer' }],
  });
});

test('the preview, the result and org show say what is not applied here, in both wordings', async () => {
  const m = machine();
  writeProfile(
    m,
    profile({
      extensions: {
        'future-thing': { required: false, since: '99.0.0' },
        'typo-thing': { required: false, since: '0.1.0' },
      },
    }),
  );
  const newer = 'not applied here: future-thing (needs 99.0.0 or later)';
  const unknown = 'not applied here: typo-thing is not an extension this release knows';
  const { prepared, result } = await add(m);
  assert.ok(prepared?.preview.includes(newer), prepared?.preview);
  assert.ok(prepared?.preview.includes(unknown), prepared?.preview);
  assert.ok(result.reported.includes(newer), JSON.stringify(result.reported));
  assert.ok(result.reported.includes(unknown), JSON.stringify(result.reported));
  assert.deepEqual(result.extensions.ignored, [
    { name: 'future-thing', since: '99.0.0', reason: 'needs-newer' },
    { name: 'typo-thing', since: '0.1.0', reason: 'unknown' },
  ]);
  const shown = await orgShow(m.core, 'acme', 'darwin');
  assert.deepEqual(shown.extensions, result.extensions);
  assert.ok(shown.notes.includes(newer), JSON.stringify(shown.notes));
  assert.ok(shown.notes.includes(unknown), JSON.stringify(shown.notes));
  // The same bytes again: nothing to change, and the result still says it.
  const again = await update(m);
  assert.equal(again.prepared, null);
  assert.equal(again.result.changed, false);
  assert.ok(again.result.reported.includes(newer));
});

test('an entry gone from the profile is dropped from the record; a changed one is a changed profile, approved first', async () => {
  const m = machine();
  writeProfile(m, profile({ extensions: { 'future-thing': { required: false, since: '99.0.0', v: 1 } } }));
  await add(m);
  writeProfile(m, profile({ extensions: { 'future-thing': { required: false, since: '99.0.0', v: 2 } } }));
  const changed = await update(m);
  assert.ok(changed.prepared, 'a changed entry is a changed profile');
  assert.equal(
    ((await record(m))?.ignoredExtensions as Record<string, { sha256?: string }> | undefined)?.['future-thing']?.sha256,
    canonicalSha({ required: false, since: '99.0.0', v: 2 }),
  );
  writeProfile(m, profile());
  const gone = await update(m);
  assert.ok(gone.prepared);
  assert.equal((await record(m))?.ignoredExtensions, undefined, 'the entry gone from the profile is dropped');
  assert.deepEqual(gone.result.extensions, { applied: [], ignored: [] });
});

test('doctor’s organisation row says how many extensions are not applied here, and stays ok', async () => {
  const m = machine();
  writeProfile(
    m,
    profile({
      extensions: {
        'future-thing': { required: false, since: '99.0.0' },
        'typo-thing': { required: false, since: '0.1.0' },
      },
    }),
  );
  await add(m);
  const report = await doctor(m.core, m.env, { keyring: null, platform: 'darwin' });
  const rows = report.checks.filter((check) => check.name === 'organisation acme');
  const line = rows.find((check) => /not applied here/.test(check.detail));
  assert.ok(line, JSON.stringify(rows));
  assert.equal(line.ok, true);
  assert.equal(line.warn, undefined, 'information, not something to look at');
  assert.equal(
    line.detail,
    '2 extensions not applied here: future-thing (needs 99.0.0 or later); typo-thing is not an extension this release knows',
  );
  // None ignored: nothing said.
  const plain = machine();
  writeProfile(plain, profile());
  await add(plain);
  const quiet = await doctor(plain.core, plain.env, { keyring: null, platform: 'darwin' });
  assert.ok(!quiet.checks.some((check) => /not applied here/.test(check.detail)));
});

test('an unknown required entry changes nothing: refused with its own code and exit 1, the configuration byte-identical', async () => {
  // Added: nothing is written.
  const fresh = machine();
  writeProfile(fresh, profile({ extensions: { 'must-have': { required: true, since: '99.0.0' } } }));
  const before = readFileSync(fresh.configPath);
  await assert.rejects(add(fresh), (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'NEEDS_NEWER_RELEASE');
    assert.equal(error.exitCode, 1);
    assert.equal(
      error.message,
      `acme's profile needs agent-communications 99.0.0 or later for "must-have": nothing was changed`,
    );
    return true;
  });
  assert.deepEqual(readFileSync(fresh.configPath), before, 'the configuration file was written');

  // Updated: the last approved record stays exactly as it was, and the hint names both commands, located.
  const m = machine();
  writeProfile(m, profile());
  await add(m);
  writeProfile(
    m,
    profile({
      label: 'Acme Renamed',
      extensions: {
        'must-have': { required: true, since: '99.0.0' },
        'optional-one': { required: false, since: '99.0.0' },
      },
    }),
  );
  const approvedBytes = readFileSync(m.configPath);
  const first = orgUpdateChange(m.core, { organisation: 'acme' }, options(m));
  await assert.rejects(gatedChange(m.core, first, { channel: 'core', surface: 'mcp' }), (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'NEEDS_NEWER_RELEASE');
    assert.equal(
      error.message,
      `acme's profile needs agent-communications 99.0.0 or later for "must-have": nothing was changed`,
    );
    const hint = String(error.hint);
    assert.ok(hint.includes(coreInline(m.core.paths, ['update'], 'darwin')), hint);
    assert.ok(hint.includes(coreInline(m.core.paths, ['org', 'update', 'acme'], 'darwin')), hint);
    assert.ok(hint.indexOf(coreInline(m.core.paths, ['update'], 'darwin')) < hint.indexOf('org update'), hint);
    return true;
  });
  assert.deepEqual(readFileSync(m.configPath), approvedBytes, 'the record moved');
  assert.deepEqual(await m.core.approvals.list({ states: ['pending'] }), [], 'an approval was prepared');
});

test('a required entry this release should know and does not is refused too, in words that do not send the member to update', async () => {
  const m = machine();
  writeProfile(m, profile({ extensions: { 'typo-thing': { required: true, since: '0.1.0' } } }));
  const before = readFileSync(m.configPath);
  await assert.rejects(add(m), (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'NEEDS_NEWER_RELEASE');
    assert.equal(
      error.message,
      `acme's profile needs "typo-thing", which this release (${VERSION}) should know and does not: nothing was changed`,
    );
    assert.match(String(error.hint), /Updating does not mend that; ask your organisation for its current profile/);
    return true;
  });
  assert.deepEqual(readFileSync(m.configPath), before);
});

// ── X4: a skipped entry is never applied as a repair ──────────────────────────────────────────────────────────────

test('the repair trap: a skipped entry the next release reads as loosening is approved first, even with the same bytes from the same place', async () => {
  const m = machine();
  const entry = { required: false, since: '0.21.0', limit: 5 };
  writeProfile(m, profile({ extensions: { 'app-limit': entry } }));
  // Release N knows nothing of it, approves the profile, and skips the entry.
  await add(m, registryOf());
  assert.deepEqual((await record(m))?.ignoredExtensions, {
    'app-limit': { since: '0.21.0', sha256: canonicalSha(entry) },
  });
  const approvedBytes = readFileSync(m.configPath);

  // Release N+1 knows it, and reads applying it as loosening: the same bytes, the same place — and still a change.
  const later = registryOf(known('app-limit', { classify: () => 'loosens' }));
  const first = await gatedChange(m.core, orgUpdateChange(m.core, { organisation: 'acme' }, options(m, later)), {
    channel: 'core',
    surface: 'mcp',
  });
  assert.equal(first.status, 'approval-required', 'a skipped entry was applied as a repair of drift');
  assert.deepEqual(readFileSync(m.configPath), approvedBytes, 'something was applied before the yes');
  const { preview, approvalId } = (first as { prepared: PreparedChange }).prepared;
  assert.match(preview, /extension app-limit: none → limit 5 \(loosens\)/);
  assert.doesNotMatch(preview, /repairs: .*app-limit/);

  // The yes: applied, and no longer listed as skipped.
  const second = await gatedChange(
    m.core,
    orgUpdateChange(m.core, { organisation: 'acme', approvalId }, options(m, later)),
    { channel: 'core', surface: 'mcp', approvalId },
  );
  assert.equal(second.status, 'applied');
  const rec = await record(m);
  assert.deepEqual((rec as { extensionsApplied?: unknown })?.extensionsApplied, { 'app-limit': { limit: 5 } });
  assert.equal(rec?.ignoredExtensions, undefined);
  assert.deepEqual((second as { result: OrgChangeResult }).result.extensions, { applied: ['app-limit'], ignored: [] });
});

test('the repair trap: a change of who acts is approved first too', async () => {
  const m = machine();
  writeProfile(m, profile({ extensions: { 'acts-as': { required: false, since: '0.21.0', limit: 1 } } }));
  await add(m, registryOf());
  const approvedBytes = readFileSync(m.configPath);
  const later = registryOf(known('acts-as', { classify: () => 'who-acts' }));
  const first = await gatedChange(m.core, orgUpdateChange(m.core, { organisation: 'acme' }, options(m, later)), {
    channel: 'core',
    surface: 'mcp',
  });
  assert.equal(first.status, 'approval-required');
  assert.deepEqual(readFileSync(m.configPath), approvedBytes);
  assert.match(
    (first as { prepared: PreparedChange }).prepared.preview,
    /extension acts-as: none → limit 1 \(changes who acts\)/,
  );
});

test('the repair trap: a skipped entry the next release reads as tightening applies at once, and is reported', async () => {
  const m = machine();
  writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 2 } } }));
  await add(m, registryOf());
  const later = registryOf(known('app-limit', { classify: () => 'tightens' }));
  const { prepared, result } = await update(m, later);
  assert.equal(prepared, null, 'a tightening asked for an approval');
  assert.equal(result.changed, true);
  assert.ok(
    result.applied.some((line) => /^extension app-limit: none → limit 2 \(tightens\)/.test(line)),
    JSON.stringify(result.applied),
  );
  const rec = await record(m);
  assert.deepEqual((rec as { extensionsApplied?: unknown })?.extensionsApplied, { 'app-limit': { limit: 2 } });
  assert.equal(rec?.ignoredExtensions, undefined);
});

test('a tightening extension applies at once beside a change that waits, and the preview marks it done', async () => {
  const m = machine();
  writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 2 } } }));
  await add(m, registryOf());
  const later = registryOf(known('app-limit', { classify: () => 'tightens' }));
  writeProfile(
    m,
    profile({ label: 'Acme Renamed', extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 2 } } }),
  );
  const first = await gatedChange(m.core, orgUpdateChange(m.core, { organisation: 'acme' }, options(m, later)), {
    channel: 'core',
    surface: 'mcp',
  });
  assert.equal(first.status, 'approval-required', 'the label still asks');
  assert.deepEqual(((await record(m)) as { extensionsApplied?: unknown })?.extensionsApplied, {
    'app-limit': { limit: 2 },
  });
  const { preview, approvalId } = (first as { prepared: PreparedChange }).prepared;
  assert.match(
    preview,
    /Done already, at once, as this was prepared:\n {2}- extension app-limit: none → limit 2 \(tightens\)/,
  );
  assert.equal((await record(m))?.label, 'Acme Test Org');
  const second = await gatedChange(
    m.core,
    orgUpdateChange(m.core, { organisation: 'acme', approvalId }, options(m, later)),
    { channel: 'core', surface: 'mcp', approvalId },
  );
  assert.equal(second.status, 'applied');
  assert.equal((await record(m))?.label, 'Acme Renamed');
  assert.ok((second as { result: OrgChangeResult }).result.applied.some((line) => /^extension app-limit: /.test(line)));
});

// ── X4, held to what the record holds: a value it never held is never a repair ───────────────────────────────────────

/** The configuration file as a hand, or another release, leaves it. */
function editRecord(m: Machine, change: (record: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(m.configPath, 'utf8')) as { organisations: { acme: Record<string, unknown> } };
  change(raw.organisations.acme);
  writeFileSync(m.configPath, `${JSON.stringify(raw, null, 2)}\n`);
}

/** The first call of an update under `registry`, as an agent makes it. */
const askUpdate = (m: Machine, registry: Registry) =>
  gatedChange(m.core, orgUpdateChange(m.core, { organisation: 'acme' }, options(m, registry)), {
    channel: 'core',
    surface: 'mcp',
  });

test('the repair trap, unlisted: an entry the record never held is a change its classifier judges, though nothing lists it skipped', async () => {
  // X4 rested on `ignoredExtensions` alone. With the entry not listed — a hand edit, or a later release that kept the
  // list otherwise and was rolled back — the record held no value, the difference went to `changes`, and the same bytes
  // moved it to `repairs`: a loosening applied at once, unasked, as "repairs: extension …".
  for (const effect of ['loosens', 'who-acts'] as const) {
    const m = machine();
    writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 5 } } }));
    await add(m, registryOf());
    editRecord(m, (rec) => {
      delete rec.ignoredExtensions;
    });
    const before = readFileSync(m.configPath);
    const first = await askUpdate(m, registryOf(known('app-limit', { classify: () => effect })));
    assert.equal(first.status, 'approval-required', `${effect}: a value the record never held was applied as a repair`);
    assert.deepEqual(readFileSync(m.configPath), before, `${effect}: something was applied before the yes`);
    const { preview } = (first as { prepared: PreparedChange }).prepared;
    assert.match(preview, /extension app-limit: none → limit 5 \((loosens|changes who acts)\)/);
    assert.doesNotMatch(preview, /repairs: .*app-limit/);
  }
  // A tightening applies at once, and is reported as done, not as a repair.
  const m = machine();
  writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 2 } } }));
  await add(m, registryOf());
  editRecord(m, (rec) => {
    delete rec.ignoredExtensions;
  });
  const { prepared, result } = await update(m, registryOf(known('app-limit', { classify: () => 'tightens' })));
  assert.equal(prepared, null);
  assert.ok(
    result.applied.some((line) => /^extension app-limit: none → limit 2 \(tightens\)/.test(line)),
    JSON.stringify(result.applied),
  );
  assert.ok(!result.applied.some((line) => /^repairs: |were changed here/.test(line) && /app-limit/.test(line)));
  assert.deepEqual(((await record(m)) as { extensionsApplied?: unknown })?.extensionsApplied, {
    'app-limit': { limit: 2 },
  });
});

test('the repair trap, withdrawn: a value the profile no longer names is taken away only as its classifier allows', async () => {
  // N+1 applies an entry; rolled back to N, which does not know it, a new profile without it is approved and N keeps
  // the record's value as it found it; N+1 again, with those same bytes, took the value away as drift — unasked.
  for (const [effect, asks] of [
    ['loosens', true],
    ['who-acts', true],
    ['tightens', false],
  ] as const) {
    const m = machine();
    const later = registryOf(known('app-limit', { classify: () => effect }));
    writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 5 } } }));
    await add(m, later);
    assert.deepEqual(((await record(m)) as { extensionsApplied?: unknown })?.extensionsApplied, {
      'app-limit': { limit: 5 },
    });
    // Release N: the profile without the entry, approved; the value N cannot see stays in the record.
    writeProfile(m, profile());
    await update(m, registryOf());
    assert.deepEqual(((await record(m)) as { extensionsApplied?: unknown })?.extensionsApplied, {
      'app-limit': { limit: 5 },
    });
    const before = readFileSync(m.configPath);
    // Release N+1 again, the same bytes from the same place.
    const first = await askUpdate(m, later);
    if (asks) {
      assert.equal(first.status, 'approval-required', `${effect}: taking the value away was applied as a repair`);
      assert.deepEqual(readFileSync(m.configPath), before, `${effect}: something was applied before the yes`);
      const { preview } = (first as { prepared: PreparedChange }).prepared;
      assert.match(preview, /extension app-limit: limit 5 → none \((loosens|changes who acts)\)/);
      assert.doesNotMatch(preview, /repairs: .*app-limit/);
    } else {
      assert.equal(first.status, 'applied', 'taking away what only tightens asked for an approval');
      const result = (first as { result: OrgChangeResult }).result;
      assert.ok(
        result.applied.some((line) => /^extension app-limit: limit 5 → none \(tightens\)/.test(line)),
        JSON.stringify(result.applied),
      );
      assert.deepEqual(((await record(m)) as { extensionsApplied?: unknown })?.extensionsApplied, {});
    }
  }
});

test('the repair trap, reshaped: a value the record holds in another form is judged by its classifier, not repaired', async () => {
  // A later release reads the same entry with a default its schema adds: the record holds the value as the earlier
  // release left it, and the difference is no hand's — nobody approved the new form, so it is not drift.
  const m = machine();
  writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 5 } } }));
  await add(m, registryOf(known('app-limit')));
  const reshaped = known('app-limit', {
    schema: z.strictObject({ limit: z.number().int().min(0), scope: z.string().default('everything') }),
    classify: () => 'loosens',
    describe: (value: unknown) =>
      value === undefined
        ? 'none'
        : `limit ${String((value as { limit?: unknown }).limit)}, ${String((value as { scope?: unknown }).scope ?? 'no scope')}`,
  });
  const before = readFileSync(m.configPath);
  const first = await askUpdate(m, registryOf(reshaped));
  assert.equal(first.status, 'approval-required', 'a value in a form nobody approved was applied as a repair');
  assert.deepEqual(readFileSync(m.configPath), before);
  assert.doesNotMatch((first as { prepared: PreparedChange }).prepared.preview, /repairs: .*app-limit/);
});

test('a malformed list of skipped entries leaves the configuration readable, is noted by doctor, and applies nothing as a repair', async () => {
  // 0.21.0 is the first release to read `ignoredExtensions`, so whatever shape a later release or a hand gives it
  // becomes a contract: read strictly, one malformed entry made the whole config.json unreadable.
  const shapes: unknown[] = [
    { 'app-limit': { since: 1, sha256: 'x' } },
    { 'app-limit': 'skipped', other: { since: '0.22.0', sha256: 'y', more: true } },
    'not a list',
    [],
  ];
  for (const shape of shapes) {
    const m = machine();
    writeProfile(m, profile({ extensions: { 'app-limit': { required: false, since: '0.21.0', limit: 5 } } }));
    await add(m, registryOf());
    editRecord(m, (rec) => {
      rec.ignoredExtensions = shape;
    });
    const where = JSON.stringify(shape);
    const config = await m.core.config.load();
    assert.ok((config as ConfigV2).organisations?.acme, `${where}: the configuration could not be read`);
    const shown = await orgShow(m.core, 'acme', 'darwin');
    assert.equal(shown.organisation, 'acme', where);
    const report = await doctor(m.core, m.env, { keyring: null, platform: 'darwin' });
    const noted = report.checks.find(
      (check) => check.name === 'organisation acme' && /cannot read, so that part is ignored/.test(check.detail),
    );
    assert.ok(noted, `${where}: doctor said nothing of it`);
    assert.equal(noted.ok, true);
    assert.equal(noted.warn, true);
    assert.match(noted.fix ?? '', /org update acme/);

    // A release that knows the entry, as loosening: the list lost, it is still never a repair.
    const before = readFileSync(m.configPath);
    const first = await askUpdate(m, registryOf(known('app-limit', { classify: () => 'loosens' })));
    assert.equal(first.status, 'approval-required', `${where}: the entry was applied as a repair`);
    assert.deepEqual(readFileSync(m.configPath), before, `${where}: something was applied before the yes`);

    // This release, the same bytes: the list is written again from the profile, and doctor is quiet.
    const again = await update(m, registryOf());
    assert.equal(again.prepared, null, `${where}: writing the list again asked somebody`);
    assert.deepEqual(
      (await record(m))?.ignoredExtensions,
      { 'app-limit': { since: '0.21.0', sha256: canonicalSha({ required: false, since: '0.21.0', limit: 5 }) } },
      where,
    );
    const after = await doctor(m.core, m.env, { keyring: null, platform: 'darwin' });
    assert.ok(!after.checks.some((check) => /cannot read, so that part is ignored/.test(check.detail)), where);
  }
});
