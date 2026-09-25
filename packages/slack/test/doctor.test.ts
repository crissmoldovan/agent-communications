import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AccountConfig, type Config, emptyConfig, newAccountId } from '@agentcomms/core';
import { BUNDLE_VERSION, type TokenBundle } from '../src/auth/bundle.ts';
import { scopesForMode } from '../src/manifest.ts';
import { doctor } from '../src/operations/doctor.ts';

/**
 * `doctor` is what somebody runs when something is wrong and the reason is not obvious, so every check has to
 * either name a fix or say honestly that it does not know. The rate-limit one is the interesting case: it is
 * deliberately *not* a probe, and the test says why.
 */

const NOW = new Date('2026-09-22T12:00:00.000Z');

function account(over: Partial<AccountConfig> = {}): AccountConfig {
  const id = newAccountId();
  return {
    id,
    platform: 'slack',
    workspace: 'T0001',
    workspaceName: 'Acme',
    userId: 'U0001',
    tier: 'read',
    mode: 'read',
    grantedScopes: scopesForMode('read'),
    secretRef: `slack/token/${id}`,
    oauthClientId: '1.2',
    appId: 'A0001',
    createdAt: NOW.toISOString(),
    ...over,
  };
}

function bundle(over: Partial<TokenBundle> = {}): TokenBundle {
  return {
    v: BUNDLE_VERSION,
    state: 'ready',
    accessToken: 'fake-access-1',
    accessExpiresAt: '2026-09-23T00:00:00.000Z',
    refreshToken: 'fake-refresh-1',
    refreshExpiresAt: '2026-10-22T12:00:00.000Z',
    issuedAt: NOW.toISOString(),
    ...over,
  };
}

function config(accounts: Record<string, AccountConfig>): Config {
  return { ...emptyConfig(), accounts };
}

const find = (result: ReturnType<typeof doctor>, id: string) => result.checks.find((check) => check.id === id);

test('a healthy install is healthy, and nothing asks to be fixed', () => {
  const result = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle()]]),
  });
  assert.equal(result.healthy, true);
  assert.equal(result.summary.fail, 0);
  for (const check of result.checks) {
    if (check.status === 'ok') assert.equal(check.fix, null, `${check.id} is ok but offers a fix`);
  }
});

test('no workspaces is a warning with the command that connects one', () => {
  const result = doctor({ config: config({}), now: NOW, bundles: new Map() });
  const check = find(result, 'workspaces');
  assert.equal(check?.status, 'warn');
  // Both halves: `workspace add` needs a Client ID that does not exist until an app does, so a fix naming only
  // the second command is one nobody can run.
  assert.match(check?.fix ?? '', /agent-slack manifest/);
  assert.match(check?.fix ?? '', /workspace add/);
  // An empty install is not broken.
  assert.equal(result.healthy, true);
});

test('an interrupted refresh is a failure that says reauth, not a retry', () => {
  /*
   * `refresh-uncertain` means a single-use refresh token may already have been spent. Nothing recovers from that
   * except a new authorisation, and saying so here is the difference between an instruction now and a puzzling
   * failure in a week.
   */
  const result = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle({ state: 'refresh-uncertain' })]]),
  });
  const check = find(result, 'credential-state');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /cannot be retried safely/);
  assert.match(check?.fix ?? '', /workspace reauth acme/);
  assert.equal(result.healthy, false);
});

test('a refresh Slack refused by name says so, with the code, rather than "interrupted"', () => {
  /*
   * The first real refresh failure has to be diagnosable from `doctor`. Every terminal refresh used to print the
   * same sentence, so `invalid_refresh_token`, a lost reply and a killed process were indistinguishable.
   */
  const dead = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([
      [
        'acme',
        bundle({
          state: 'refresh-uncertain',
          reason: { kind: 'dead', stage: 'refused', slackError: 'invalid_refresh_token', at: NOW.toISOString() },
        }),
      ],
    ]),
  });
  const check = find(dead, 'credential-state');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /no longer valid \(invalid_refresh_token\)/);
  assert.match(check?.fix ?? '', /workspace reauth acme/);

  const lost = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([
      [
        'acme',
        bundle({
          state: 'refresh-uncertain',
          reason: { kind: 'uncertain', stage: 'http', httpStatus: 503, at: NOW.toISOString() },
        }),
      ],
    ]),
  });
  assert.match(find(lost, 'credential-state')?.detail ?? '', /did not complete \(http, 503\)/);
});

test('a secret store that will not answer is its own finding, and its fix is not reauth', () => {
  const result = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', { storeUnavailable: 'the system keychain did not answer within 12s' }]]),
  });
  const check = find(result, 'credential');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /secret store could not be read.*did not answer/);
  assert.doesNotMatch(check?.fix ?? '', /reauth/, 're-authorising would discard a refresh token nothing says is bad');
  assert.doesNotMatch(check?.detail ?? '', /corrupt/);
});

test('an expiring refresh token warns while reauthorising is still a choice', () => {
  // Slack expires them 30 days after issue. A workspace nobody has touched for a month just stops working, and
  // the failure gives no hint that the clock was the cause.
  const soon = new Date(NOW.getTime() + 2 * 24 * 60 * 60_000).toISOString();
  const result = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle({ refreshExpiresAt: soon })]]),
  });
  const check = find(result, 'refresh-expiry');
  assert.equal(check?.status, 'warn');
  assert.match(check?.fix ?? '', /reauth acme/);
  assert.equal(result.healthy, true, 'a warning is not a broken install');
});

test('an expired refresh token is a failure that names the 30 days', () => {
  const result = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle({ refreshExpiresAt: '2026-09-01T00:00:00.000Z' })]]),
  });
  const check = find(result, 'refresh-expiry');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /30 days/);
});

test('scope drift is a failure, in both directions', () => {
  /*
   * Scopes change under us: an admin can narrow an app, and optional scopes let a person grant less than was
   * asked for. A `read` install claiming it cannot post is only true while this holds.
   */
  const widened = account({ grantedScopes: [...scopesForMode('read'), 'chat:write'] });
  const result = doctor({ config: config({ acme: widened }), now: NOW, bundles: new Map([['acme', bundle()]]) });
  const check = find(result, 'scopes');
  assert.equal(check?.status, 'fail');
  assert.match(check?.detail ?? '', /more than "read" allows: chat:write/);

  const narrowed = account({ grantedScopes: scopesForMode('read').filter((s) => s !== 'search:read') });
  const second = doctor({ config: config({ acme: narrowed }), now: NOW, bundles: new Map([['acme', bundle()]]) });
  assert.match(find(second, 'scopes')?.detail ?? '', /missing search:read/);
});

test('a stored credential that cannot be read is a different finding from one that is not there', () => {
  /*
   * Both are failures and both are fixed by `reauth`, but they are not the same sentence. Saying "no stored
   * token" for a credential that is very much stored sends somebody to `workspace add` — which then refuses it
   * as already connected, in a command they ran precisely because they did not know what was wrong.
   */
  const missing = doctor({ config: config({ acme: account() }), now: NOW, bundles: new Map([['acme', null]]) });
  assert.equal(find(missing, 'credential')?.status, 'fail');
  assert.match(find(missing, 'credential')?.detail ?? '', /no stored token/);
  assert.match(find(missing, 'credential')?.fix ?? '', /reauth acme/);

  const corrupt = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', 'unreadable']]),
  });
  assert.equal(find(corrupt, 'credential')?.status, 'fail');
  assert.match(find(corrupt, 'credential')?.detail ?? '', /cannot be read/);
  assert.doesNotMatch(find(corrupt, 'credential')?.detail ?? '', /no stored token/);
});

test('an expired access token is not reported as valid until the moment it expired', () => {
  // This printed the stored string whatever it said, in the one command somebody runs to find out why nothing
  // works. Expiry is ordinary — the next call renews it — so it is a note, not a failure.
  const stale = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle({ accessExpiresAt: '2026-09-22T00:00:00.000Z' })]]),
  });
  const check = find(stale, 'credential-state');
  assert.equal(check?.status, 'warn');
  assert.match(check?.detail ?? '', /expired/);
  assert.doesNotMatch(check?.detail ?? '', /valid until/);

  const broken = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle({ accessExpiresAt: 'whenever' })]]),
  });
  assert.equal(find(broken, 'credential-state')?.status, 'fail');
  assert.match(find(broken, 'credential-state')?.fix ?? '', /reauth acme/);
});

test('the rate-limit check reports expected versus observed, and never probes', () => {
  /*
   * This wanted to be a probe and cannot be one. Slack publishes no remaining/limit headers, leaves burst
   * tolerance deliberately loose, and says `conversations.history` may return fewer items than requested even
   * when more remain — so a short page proves nothing and one 429 proves throttling, not a tier. The only way to
   * observe the cap is to spend the budget being measured.
   */
  const quiet = doctor({ config: config({ acme: account() }), now: NOW, bundles: new Map([['acme', bundle()]]) });
  const check = find(quiet, 'rate-limit');
  // Not `ok`: nothing has been observed, and green reads as "checked, and fine".
  assert.equal(check?.status, 'unknown');
  assert.match(check?.detail ?? '', /expected Tier 3/);
  assert.match(check?.detail ?? '', /not yet observed/, 'it implied health it has not observed');

  const throttled = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle()]]),
    rateEvidence: { lastThrottledAt: '2026-09-22T11:00:00.000Z', retryAfterSeconds: 30 },
  });
  const seen = find(throttled, 'rate-limit');
  assert.equal(seen?.status, 'warn');
  assert.match(seen?.detail ?? '', /Retry-After 30s/);
});

test('not having looked for other Slack servers is reported as not having looked', () => {
  /*
   * "None registered" for a scan that never ran is a clean bill of health nobody earned. Nothing scans for these
   * yet — that arrives with the MCP surface — so absent and empty have to read differently.
   */
  const result = doctor({ config: config({ acme: account() }), now: NOW, bundles: new Map([['acme', bundle()]]) });
  const check = find(result, 'other-slack-servers');
  assert.equal(check?.status, 'unknown');
  assert.equal(check?.detail, 'not checked on this machine');

  const scanned = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle()]]),
    otherSlackServers: [],
  });
  assert.equal(find(scanned, 'other-slack-servers')?.detail, 'none registered');
});

test('another Slack server on this machine is reported, because it is a second route', () => {
  // The Gmail release found six other Gmail servers registered locally, any of which could send with no approval
  // step. Everything here assumes it owns the only route to Slack's posting methods.
  const result = doctor({
    config: config({ acme: account() }),
    now: NOW,
    bundles: new Map([['acme', bundle()]]),
    otherSlackServers: ['cursor'],
  });
  const check = find(result, 'other-slack-servers');
  assert.equal(check?.status, 'warn');
  assert.match(check?.detail ?? '', /cursor/);
  assert.match(check?.fix ?? '', /without any approval/);
});

test('every check names its workspace, or says it is not about one', () => {
  // A list of findings with no owner is unreadable once there is more than one workspace.
  const result = doctor({
    config: config({ acme: account(), zed: account({ userId: 'U0002' }) }),
    now: NOW,
    bundles: new Map([
      ['acme', bundle()],
      ['zed', bundle()],
    ]),
  });
  for (const check of result.checks) {
    if (check.workspace !== null) assert.ok(['acme', 'zed'].includes(check.workspace), check.id);
    assert.ok(check.title.length > 0);
  }
});
