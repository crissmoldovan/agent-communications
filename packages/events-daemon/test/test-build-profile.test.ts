import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin, openCore, resolvePaths, TEST_PROFILE_MARKER } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { isTestProfileState, withinTestProfile } from '../src/runtime/test-profile.ts';
import { dryRun, type LaneHarness, rule, withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Security review of 0.34.0, finding 1 (LOW): the local test build speaks only for its own test profile, but the CLI
 * checked only the config folder it was given, while the act goes to the event service of the state folder it was
 * given: `--config-dir <a marked temporary folder> --state-dir <the real one>` approved on the real service as the test
 * build. Now the CLI takes the test build's origin only when the config and the state folder are both in the test
 * profile's folder, and the event service itself takes it only when its own state folder holds the test profile's
 * mark and is not the person's real, default one (found from the account's home, never the environment).
 */

const APPROVAL_EXIT = new CommsError('APPROVAL_REQUIRED', 'x').exitCode;
const TEST_BUILD = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'test',
  identifier: 'com.cueplusplus.agentcomms.test',
});
const PLACEHOLDER = `ap_${'0'.repeat(26)}`;
const ZEROES = '0'.repeat(64);

async function cli(
  args: readonly string[],
  desktopOrigin: () => Promise<DesktopOrigin> = TEST_BUILD,
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  stdin.end('');
  const stdout = Object.assign(new PassThrough(), { isTTY: false });
  const stderr = Object.assign(new PassThrough(), { isTTY: false });
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk;
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await run(args, { env: {}, desktopOrigin, streams: { stdin, stdout, stderr } });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

async function mark(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, TEST_PROFILE_MARKER), '');
}

test('the CLI takes the test build only when the config and state folders are both in the test profile', async () => {
  const profile = await shortTempDir('aev-test-profile-');
  const elsewhere = await shortTempDir('aev-real-state-');
  try {
    await mark(join(profile, 'config'));
    const person = [
      ['collection', 'approve', PLACEHOLDER, '--digest', ZEROES],
      ['rule', 'approve', PLACEHOLDER, '--digest', ZEROES],
      ['judge', 'setup', 'local-endpoint', '--url', 'http://127.0.0.1:11434'],
      ['provider', 'key', 'remove', 'openrouter'],
    ];
    // A marked config folder with another state folder: refused before any event service is asked.
    for (const args of person) {
      const ran = await cli(['--config-dir', join(profile, 'config'), '--state-dir', elsewhere, '--json', ...args]);
      assert.equal(ran.code, APPROVAL_EXIT, `${args.join(' ')}: ${ran.err}`);
      assert.match(
        ran.err,
        /^the Agent Comms test build changes only its own test profile, and this command's config and state folders are not both in one/u,
      );
      assert.equal(ran.out, '');
    }
    // The test profile's own folders go on to its event service, which is not running here.
    for (const args of person) {
      const ran = await cli([
        '--config-dir',
        join(profile, 'config'),
        '--state-dir',
        join(profile, 'state'),
        '--json',
        ...args,
      ]);
      assert.notEqual(ran.code, APPROVAL_EXIT, `${args.join(' ')}: ${ran.err}`);
      assert.match(ran.err, /not running/iu, args.join(' '));
    }
    // The release app is not a test build: its folders are not checked here.
    const release = await cli(
      ['--config-dir', join(profile, 'config'), '--state-dir', elsewhere, '--json', ...(person[0] ?? [])],
      async () => ({ ok: true, build: 'release', identifier: 'com.cueplusplus.agentcomms' }),
    );
    assert.notEqual(release.code, APPROVAL_EXIT, release.err);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('the test profile is a marked state folder that is not the default one, and folders are compared as they really are', async () => {
  const root = await shortTempDir('aev-profile-check-');
  try {
    const home = join(root, 'home');
    const state = join(root, 'profile', 'state');
    await mkdir(state, { recursive: true });
    assert.equal(isTestProfileState(state, home), false, 'no mark');
    await mark(state);
    assert.equal(isTestProfileState(state, home), true, 'marked');
    // The person's real, default state folder is never a test profile, marked or not.
    const real = resolvePaths({ env: {}, home }).stateDir;
    await mark(real);
    assert.equal(isTestProfileState(real, home), false, 'the default state folder');
    const link = join(root, 'link-to-real');
    await symlink(real, link);
    assert.equal(isTestProfileState(link, home), false, 'the default state folder, reached through a link');
    // A mark that is a link or a folder is no mark.
    const linked = join(root, 'linked-mark');
    await mkdir(linked);
    await symlink(join(state, TEST_PROFILE_MARKER), join(linked, TEST_PROFILE_MARKER));
    assert.equal(isTestProfileState(linked, home), false, 'a linked mark');
    const folder = join(root, 'folder-mark');
    await mkdir(join(folder, TEST_PROFILE_MARKER), { recursive: true });
    assert.equal(isTestProfileState(folder, home), false, 'a folder named as the mark');

    // The CLI's check: both folders in the folder the config folder is in, followed through links.
    const profile = join(root, 'profile');
    assert.equal(withinTestProfile(join(profile, 'config'), join(profile, 'state')), true);
    assert.equal(withinTestProfile(join(profile, 'config'), join(profile, 'state', 'not-yet-made')), true);
    assert.equal(withinTestProfile(join(profile, 'config'), real), false);
    assert.equal(withinTestProfile(join(profile, 'config'), join(profile, '..', 'other')), false);
    await symlink(dirname(real), join(profile, 'escape'));
    assert.equal(withinTestProfile(join(profile, 'config'), join(profile, 'escape', 'state')), false, 'a link out');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A rule on, collection off, and the switch-on approval waiting, on the harness's own owner. */
async function prepared(harness: LaneHarness): Promise<{ approvalId: string; binding: { digest: string } }> {
  await harness.control.request('target-add', { document: dryRun });
  await harness.control.request('rule-create', { document: rule(1, [dryRun]) });
  await harness.approve(1);
  return (await harness.control.request('enable-all')) as { approvalId: string; binding: { digest: string } };
}

test('the event service takes the test build only when its own state folder is a marked test profile', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    const configDir = join(stateDir, '..', 'config');
    const planned = await prepared(harness);
    const words = [
      '--config-dir',
      configDir,
      '--state-dir',
      stateDir,
      '--json',
      'collection',
      'approve',
      planned.approvalId,
      '--digest',
      planned.binding.digest,
    ];
    await mark(configDir);

    // Its state folder is not marked: whatever the CLI found, the event service refuses the test build.
    const refused = await cli(words);
    assert.equal(refused.code, APPROVAL_EXIT, refused.err);
    assert.match(
      refused.err,
      /^the Agent Comms test build changes only its own test profile, and this event service is not one/u,
    );
    const testBuild = new EventControlClient({ stateDir, clientName: 'person-setup:desktop-app-test-build' });
    for (const [operation, args] of [
      ['enable-all-approve', { approvalId: planned.approvalId, digest: planned.binding.digest }],
      ['judge-setup', { kind: 'local-endpoint', url: 'http://127.0.0.1:9' }],
      ['provider-key-remove', { provider: 'openrouter' }],
      ['integration-set', { integration: 'agent-sessions', relayPort: 45555 }],
    ] as const)
      await assert.rejects(testBuild.request(operation, args), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'APPROVAL_REQUIRED', operation);
        assert.equal((error as { details?: { reason?: string } }).details?.reason, 'NOT_A_TEST_PROFILE', operation);
        return true;
      });
    const core = openCore({ pathOverrides: { stateDir, configDir } });
    const refusals = (await core.audit.tail({ limit: 100 }))
      .filter((line) => line.reason === 'NOT_A_TEST_PROFILE')
      .map((line) => [line.operation, line.outcome, (line.ids as { approvedBy?: string }).approvedBy]);
    assert.deepEqual(refusals, [
      ['events.enableAllApprove', 'refused', 'desktop-app (test build)'],
      ['events.enableAllApprove', 'refused', 'desktop-app (test build)'],
      ['events.judgeSetup', 'refused', 'desktop-app (test build)'],
      ['events.providerKeyRemove', 'refused', 'desktop-app (test build)'],
      ['events.integrationSet', 'refused', 'desktop-app (test build)'],
    ]);
    const status = (await harness.control.request('status')) as { enabled?: boolean };
    assert.equal(status.enabled, false, 'nothing was switched on');

    // The genuine test profile: its folders together, its state folder marked as the test profile's.
    await mark(stateDir);
    const approved = await cli(words);
    assert.equal(approved.code, 0, approved.err);
    assert.equal((JSON.parse(approved.out) as { approvedBy: string }).approvedBy, 'desktop-app (test build)');
    assert.equal(((await harness.control.request('status')) as { enabled?: boolean }).enabled, true);
  });
});
