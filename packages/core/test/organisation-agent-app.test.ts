import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ConfigV2, emptyConfig, type OrganisationRecord } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import {
  AGENT_APP_KIND,
  agentAppPathFor,
  organisationAgentApp,
  parseProfile,
  readProfileFile,
} from '../src/organisations.ts';
import { writeAsReleased0121 } from './fixtures/config-v2-0.12.1.ts';
import { readAsReleased0190 } from './fixtures/profile-schema-0.19.0.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * An organisation's agent app (CUE-493, decided 2026-10-16): one bot-only Slack app per organisation, whose bot token
 * members paste once with `workspace bot`. The profile names it so that the paste can be checked against it.
 *
 * Where the name goes is the compatibility question. Every object of a version-1 profile is a strict object in every
 * release since profiles were added (0.13.0 to 0.19.0), so `slack.apps.agent` — or any other new key, anywhere — would
 * make a member still on one of those releases refuse the whole profile at `org update`, and with it whatever else the
 * organisation changed. So the profile file stays exactly as those releases read it, and the agent app is named in a
 * small companion file beside it, `<profile>.agent-app.json`, which they never open. This release reads both.
 */

const AGENT_APP = 'A0AGENT0001';

function profile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentcomms: 'organisation-profile',
    version: 1,
    organisation: 'acme',
    label: 'Acme Test Org',
    slack: {
      workspace: 'TACME0001',
      workspaceName: 'Acme Test Org',
      redirectPort: 51234,
      apps: { read: { clientId: '1111.2222' }, send: { clientId: '1111.3333' } },
    },
    ...over,
  };
}

function agentApp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentcomms: AGENT_APP_KIND,
    version: 1,
    organisation: 'acme',
    slack: { workspace: 'TACME0001', appId: AGENT_APP },
    ...over,
  };
}

/** The organisation's repository: its profile, and — when given — the agent app's file beside it. */
function repository(document = profile(), agent?: Record<string, unknown> | string): { dir: string; path: string } {
  const dir = tempDir('comms-agent-app-');
  const path = join(dir, 'acme.agentcomms.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  if (agent !== undefined) {
    writeFileSync(
      join(dir, 'acme.agentcomms.agent-app.json'),
      typeof agent === 'string' ? agent : `${JSON.stringify(agent, null, 2)}\n`,
    );
  }
  return { dir, path };
}

function refusedWith(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'BAD_DATA', `${error.code}: ${error.message}`);
    assert.match(`${error.message} ${error.hint ?? ''}`, pattern);
    return true;
  };
}

// ── Compatibility with the releases before this one ────────────────────────────────────────────────────────────────

test('an organisation that names its agent app publishes a profile 0.19.0 still reads, and this release reads the app', async () => {
  const { path } = repository(profile(), agentApp());
  // The bytes a member on 0.19.0 — or any release since 0.13.0 — reads at `org update`: accepted, unchanged.
  assert.deepEqual(readAsReleased0190(readFileSync(path, 'utf8')), { ok: true });
  // This release reads the profile as before, and the agent app from the file beside it.
  const read = await readProfileFile(path);
  assert.equal(read.profile.organisation, 'acme');
  assert.equal(read.agentApp?.appId, AGENT_APP);
  assert.equal(read.agentApp?.path, join(path, '..', 'acme.agentcomms.agent-app.json'));
  assert.match(read.agentApp?.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(read.agentApp?.sha256, read.sha256, 'each file is bound by its own SHA-256');
});

test('the agent app named inside the profile would be refused by 0.19.0, so it is not put there', () => {
  const inside = profile({
    slack: { ...(profile().slack as object), apps: { send: { clientId: '1111.3333' }, agent: { appId: AGENT_APP } } },
  });
  const old = readAsReleased0190(JSON.stringify(inside));
  assert.equal(old.ok, false, 'a member on 0.19.0 would lose `org update` for the whole profile');
  assert.match(old.ok ? '' : old.issues.join('; '), /slack\.apps: agent is not a key/);
  // Wherever else it went — the top level, beside the apps — it is refused the same way: every object is strict.
  for (const elsewhere of [
    profile({ agentApp: { appId: AGENT_APP } }),
    profile({ slack: { ...(profile().slack as object), agentApp: AGENT_APP } }),
  ]) {
    assert.equal(readAsReleased0190(JSON.stringify(elsewhere)).ok, false);
  }
  // And this release keeps the version-1 profile exactly as strict: the same document is refused here too, so the two
  // never disagree about what a profile is.
  assert.throws(() => parseProfile(JSON.stringify(inside)), refusedWith(/slack\.apps: "agent" is not a key/));
});

test('this release accepts and refuses version-1 profiles exactly as 0.19.0 does', () => {
  const samples: Record<string, unknown>[] = [
    profile(),
    profile({ slack: undefined }),
    profile({ gmail: { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'x', serves: 'any' } }),
    profile({ version: 2 }),
    profile({ extra: true }),
    profile({ slack: { ...(profile().slack as object), apps: { read: { clientId: '1.2', appId: 'B0' } } } }),
  ];
  for (const sample of samples) {
    const text = JSON.stringify(sample);
    let here = true;
    try {
      parseProfile(text);
    } catch {
      here = false;
    }
    assert.equal(here, readAsReleased0190(text).ok, text);
  }
});

test('a record naming the agent app is kept through a write by an older release', () => {
  const config = emptyConfig() as ConfigV2;
  const record: OrganisationRecord = {
    label: 'Acme Test Org',
    source: { kind: 'file', path: '/profiles/acme.agentcomms.json' },
    sha256: 'a'.repeat(64),
    readAt: '2026-10-16T12:00:00.000Z',
    addedAt: '2026-10-16T12:00:00.000Z',
    forOtherAddresses: false,
    slack: {
      workspace: 'TACME0001',
      workspaceName: 'Acme Test Org',
      redirectPort: 51234,
      apps: { send: { clientId: '1111.3333' }, agent: { appId: AGENT_APP, sha256: 'b'.repeat(64) } },
    },
  };
  const written = writeAsReleased0121(JSON.stringify({ ...config, organisations: { acme: record } }), (raw) => {
    raw.defaults = { ...(raw.defaults as object), sendPolicy: 'confirm' };
  });
  const kept = JSON.parse(written) as ConfigV2;
  assert.deepEqual(kept.organisations?.acme?.slack?.apps.agent, { appId: AGENT_APP, sha256: 'b'.repeat(64) });
});

// ── The companion file ─────────────────────────────────────────────────────────────────────────────────────────────

test('the agent app’s file is the profile’s name with .agent-app.json for its .json, in the same folder', () => {
  assert.equal(agentAppPathFor('/p/rgc.agentcomms.json'), '/p/rgc.agentcomms.agent-app.json');
  assert.equal(agentAppPathFor('/p/RGC.JSON'), '/p/RGC.agent-app.json');
  assert.equal(agentAppPathFor('/p/rgc-profile'), '/p/rgc-profile.agent-app.json');
});

test('a profile with no agent app file beside it reads as it always did, naming none', async () => {
  const { path } = repository();
  const read = await readProfileFile(path);
  assert.equal(read.agentApp, undefined);
  assert.equal(read.profile.organisation, 'acme');
});

test('the agent app file is strict, and every refusal names it, never the profile', async () => {
  const cases: [Record<string, unknown> | string, RegExp][] = [
    [agentApp({ extra: 1 }), /"extra" is not a key/],
    [agentApp({ slack: { workspace: 'TACME0001', appId: AGENT_APP, token: 'x' } }), /"token" is not a key/],
    [agentApp({ agentcomms: 'organisation-profile' }), /agentcomms/],
    [agentApp({ version: 2 }), /version/],
    [agentApp({ slack: { workspace: 'TACME0001', appId: 'B0BOT' } }), /app id/],
    [agentApp({ slack: { workspace: 'TACME0001' } }), /appId/],
    [agentApp({ organisation: 'other' }), /names the organisation other, not acme/],
    [agentApp({ slack: { workspace: 'TOTHER01', appId: AGENT_APP } }), /workspace TOTHER01, not TACME0001/],
    ['{"agentcomms":', /not valid JSON/],
  ];
  for (const [document, pattern] of cases) {
    const { path } = repository(profile(), document);
    await assert.rejects(readProfileFile(path), (error: unknown) => {
      refusedWith(pattern)(error);
      assert.match((error as CommsError).message, /acme\.agentcomms\.agent-app\.json/);
      return true;
    });
  }
  // An agent app for a profile that lists no Slack workspace has nothing to post in.
  const { path } = repository(profile({ slack: undefined }), agentApp());
  await assert.rejects(readProfileFile(path), refusedWith(/lists no Slack workspace/));
});

test('an agent app file that is not a file, or past 64 KiB, is refused rather than read', async () => {
  const folder = repository();
  mkdirSync(join(folder.dir, 'acme.agentcomms.agent-app.json'));
  await assert.rejects(
    readProfileFile(folder.path),
    (error: unknown) => error instanceof CommsError && /agent-app\.json is not a file/.test(error.message),
  );
  const big = repository(profile(), `${JSON.stringify(agentApp())}${' '.repeat(64 * 1024)}`);
  await assert.rejects(
    readProfileFile(big.path),
    (error: unknown) => error instanceof CommsError && /64 KiB/.test(error.message),
  );
});

// ── Reading it back ────────────────────────────────────────────────────────────────────────────────────────────────

test('the agent app a configuration records is found by organisation and workspace, and only for that workspace', () => {
  const config = emptyConfig() as ConfigV2;
  config.organisations = {
    acme: {
      label: 'Acme Test Org',
      source: { kind: 'file', path: '/profiles/acme.agentcomms.json' },
      sha256: 'a'.repeat(64),
      readAt: '2026-10-16T12:00:00.000Z',
      addedAt: '2026-10-16T12:00:00.000Z',
      forOtherAddresses: false,
      slack: {
        workspace: 'TACME0001',
        workspaceName: 'Acme Test Org',
        redirectPort: 51234,
        apps: { send: { clientId: '1111.3333' }, agent: { appId: AGENT_APP, sha256: 'b'.repeat(64) } },
      },
    },
  };
  assert.deepEqual(organisationAgentApp(config, 'acme', 'TACME0001'), { appId: AGENT_APP });
  assert.equal(organisationAgentApp(config, 'acme', 'TOTHER01'), undefined, 'another workspace has none');
  assert.equal(organisationAgentApp(config, 'other', 'TACME0001'), undefined);
  assert.equal(organisationAgentApp(config, 'constructor', 'TACME0001'), undefined, 'an own property only');
  const none = structuredClone(config);
  delete none.organisations?.acme?.slack?.apps.agent;
  assert.equal(organisationAgentApp(none, 'acme', 'TACME0001'), undefined);
  // A value that is not an app id — a hand edit — is still named, so a check against it refuses every token rather
  // than none: read as the stricter of the two.
  const odd = structuredClone(config);
  const apps = odd.organisations?.acme?.slack?.apps as Record<string, unknown>;
  apps.agent = { appId: 'B0NOTANAPP', sha256: 'b'.repeat(64) };
  assert.deepEqual(organisationAgentApp(odd, 'acme', 'TACME0001'), { appId: 'B0NOTANAPP' });
});
