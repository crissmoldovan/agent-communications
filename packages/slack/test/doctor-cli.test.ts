import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { run } from '../src/cli/program.ts';
import { type Harness, newHarness, slackOk } from './support/harness.ts';

/**
 * `doctor` against a credential that is due, one that must not be refreshed, and a store that will not answer.
 *
 * Its own file rather than more of `cli.test.ts`, which is already close to the per-file timeout on a busy machine.
 */

interface Envelope<T> {
  ok: boolean;
  data?: T;
}

async function cli(harness: Harness, argv: string[]): Promise<{ code: number; json: <T>() => T }> {
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
    openBrowser: () => undefined,
    probe: (input, init) => harness.probe(input, init),
  });
  return { code, json: <T>() => JSON.parse(stdout) as T };
}

test('an expired but refreshable token is renewed first, then asked about — not skipped', async () => {
  /*
   * An expired access token is the ordinary state of a workspace nobody has used today. `doctor` used to skip it,
   * because Slack would refuse it — so the one command run to find out whether a workspace works never checked the
   * workspace most likely to be in question. It now does what the next read would: renews it under the same locks,
   * then asks Slack about the token that came back.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', bundle: { accessExpiresAt: '2020-01-01T00:00:00.000Z' } });
  harness.reply = () =>
    slackOk({ authed_user: { access_token: 'fake-renewed-token', refresh_token: 'fake-renewed-refresh' } });
  const sentWith: string[] = [];
  harness.probe = (_input, init) => {
    sentWith.push(new Headers(init?.headers).get('authorization') ?? '');
    return Promise.resolve(harness.authTest());
  };

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(harness.calls.length, 1, 'doctor did not renew a token that was due');
  assert.equal(harness.calls[0]?.params.grant_type, 'refresh_token');
  assert.deepEqual(
    sentWith,
    ['Bearer fake-renewed-token'],
    'doctor asked about the expired token, not the renewed one',
  );
  const checks = result.json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>().data?.checks;
  assert.equal(checks?.find((check) => check.id === 'identity')?.status, 'ok');
  assert.match(
    checks?.find((check) => check.id === 'credential-state')?.detail ?? '',
    /valid until/,
    'the state check described the credential from before the renewal',
  );
});

test('an expired token that must not be refreshed is neither renewed nor asked about', async () => {
  /*
   * `refresh-uncertain` may hold a spent refresh token, and nothing may present it again — doctor included.
   * Counted, not `assert.fail`ed inside the probe: `probeIdentity` turns every thrown thing into
   * `{ kind: 'unreachable' }` on purpose, so an assertion raised in there is swallowed.
   */
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    bundle: { state: 'refresh-uncertain', accessExpiresAt: '2020-01-01T00:00:00.000Z' },
  });
  let asked = 0;
  harness.probe = () => {
    asked += 1;
    return Promise.resolve(harness.authTest());
  };

  const result = await cli(harness, ['--json', 'doctor']);
  assert.equal(harness.calls.length, 0, 'doctor presented a refresh token that may already be spent');
  assert.equal(asked, 0, 'doctor asked Slack about a token it already knew was stale');
  const checks = result.json<Envelope<{ checks: { id: string; status: string; detail: string }[] }>>().data?.checks;
  const identity = checks?.find((check) => check.id === 'identity');
  assert.equal(identity?.status, 'unknown');
  assert.equal(identity?.detail, 'not asked', 'doctor tried to renew a credential it knew could not be renewed');
  assert.equal(checks?.find((check) => check.id === 'credential-state')?.status, 'fail');
});

test('a secret store that will not answer is not reported as a corrupt credential', async () => {
  /*
   * Both used to read "unreadable", whose fix is `reauth` — advice that, for a keychain that only wanted
   * unlocking, throws away a refresh token that was fine. The file store stands in for the keychain here: its
   * entry is replaced by a directory, so reading it fails in the store rather than in the parse.
   */
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const entry = join(
    harness.core.paths.secretsDir,
    `${createHash('sha256').update(account.secretRef).digest('hex').slice(0, 32)}.json`,
  );
  rmSync(entry);
  mkdirSync(entry);

  const result = await cli(harness, ['--json', 'doctor', '--offline']);
  const checks =
    result.json<Envelope<{ checks: { id: string; status: string; detail: string; fix: string }[] }>>().data?.checks;
  const credential = checks?.find((check) => check.id === 'credential');
  assert.equal(credential?.status, 'fail');
  assert.match(credential?.detail ?? '', /secret store could not be read/);
  assert.doesNotMatch(credential?.fix ?? '', /reauth/, 'a store problem was answered with re-authorisation');
});
