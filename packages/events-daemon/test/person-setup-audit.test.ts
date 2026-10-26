import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openCore, TEST_PROFILE_MARKER } from '@agentcomms/core';
import { EventControlClient } from '../src/control/client.ts';
import { dryRun, rule, withLaneOwner } from './support/lane-harness.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Security review of 0.34.0, finding 2 (LOW): the person-only changes' audit lines said `surface: app` and `origin: app`
 * for every caller that was not a terminal — a control client of no known origin, the app unattested, a test build
 * outside its profile. An audit line says `app` now only for an attested app (the release, or the test build in its
 * own test profile) and `cli` for a terminal; for anything else it names no surface, and its reason says why it was
 * refused.
 */

interface Line {
  readonly operation: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly surface?: string;
  readonly origin?: string;
  readonly ids?: { readonly approvedBy?: string };
}

test('a person-only change is audited as the app only from an attested app, as the CLI from a terminal, else neither', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    const configDir = join(stateDir, '..', 'config');
    await harness.control.request('target-add', { document: dryRun });
    await harness.control.request('rule-create', { document: rule(1, [dryRun]) });
    await harness.approve(1);
    const planned = (await harness.control.request('enable-all')) as {
      approvalId: string;
      binding: { digest: string };
    };
    const asked = async (clientName: string, operation: string, args: Record<string, unknown>) =>
      new EventControlClient({ stateDir, clientName }).request(operation, args).then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    const switchOn = { approvalId: planned.approvalId, digest: planned.binding.digest };
    for (const clientName of [
      'events-cli',
      'person-setup:desktop-app-unattested',
      'person-setup:desktop-app-test-build',
      'person-setup:terminal',
    ])
      assert.equal(await asked(clientName, 'enable-all-approve', switchOn), 'APPROVAL_REQUIRED', clientName);
    assert.equal(
      await asked('events-cli', 'judge-setup', { kind: 'local-endpoint', url: 'http://127.0.0.1:9' }),
      'APPROVAL_REQUIRED',
    );
    assert.equal(
      await asked('events-cli', 'integration-set', { integration: 'agent-sessions', relayPort: 45555 }),
      'APPROVAL_REQUIRED',
    );
    assert.equal(
      await asked('person-setup:desktop-app-unattested', 'integration-set', {
        integration: 'agent-sessions',
        relayPort: 45555,
      }),
      'APPROVAL_REQUIRED',
    );
    // The test build in its own test profile, and the release app, are the app.
    await writeFile(join(stateDir, TEST_PROFILE_MARKER), '');
    assert.equal(
      await asked('person-setup:desktop-app-test-build', 'integration-set', {
        integration: 'agent-sessions',
        relayPort: 45556,
      }),
      'ok',
    );
    assert.equal(await asked('person-setup:desktop-app', 'enable-all-approve', switchOn), 'ok');

    const lines = (
      (await openCore({ pathOverrides: { stateDir, configDir } }).audit.tail({ limit: 100 })) as unknown as Line[]
    )
      .filter((line) =>
        ['events.enableAllApprove', 'events.judgeSetup', 'events.integrationSet'].includes(line.operation),
      )
      .map((line) => [
        line.operation,
        line.outcome,
        line.reason ?? null,
        line.ids?.approvedBy ?? null,
        Object.hasOwn(line, 'surface') ? line.surface : 'none',
        Object.hasOwn(line, 'origin') ? line.origin : 'none',
      ]);
    assert.deepEqual(lines, [
      ['events.enableAllApprove', 'refused', 'PERSON_SETUP_ONLY', null, 'none', 'none'],
      ['events.enableAllApprove', 'refused', 'ORIGIN_UNATTESTED', 'desktop-app (unattested)', 'none', 'none'],
      ['events.enableAllApprove', 'refused', 'NOT_A_TEST_PROFILE', 'desktop-app (test build)', 'none', 'none'],
      ['events.enableAllApprove', 'refused', 'AT_TERMINAL', 'terminal', 'cli', 'cli'],
      ['events.judgeSetup', 'refused', 'PERSON_SETUP_ONLY', null, 'none', 'none'],
      ['events.integrationSet', 'refused', 'PERSON_SETUP_ONLY', null, 'none', 'none'],
      ['events.integrationSet', 'refused', 'ORIGIN_UNATTESTED', 'desktop-app (unattested)', 'none', 'none'],
      ['events.integrationSet', 'ok', null, 'desktop-app (test build)', 'app', 'app'],
      ['events.enableAllApprove', 'ok', null, 'desktop-app', 'app', 'app'],
    ]);
  });
});

test('an approval from the app for a digest the person did not see, or one no longer waiting, is audited as refused', {
  skip: WINDOWS_SKIP,
}, async () => {
  // Security review of 0.34.0, finding 4 (INFO): a digest mismatch on collection approve, as on rule approve, was
  // audited as `failed`. Nothing was done: it is a refusal, with its reason.
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    const configDir = join(stateDir, '..', 'config');
    await harness.control.request('target-add', { document: dryRun });
    await harness.control.request('rule-create', { document: rule(1, [dryRun]) });
    const ruleOn = (await harness.control.request('rule-enable', { ruleId: rule(1, []).ruleId, version: 1 })) as {
      approvalId: string;
      binding: { digest: string };
    };
    const app = new EventControlClient({ stateDir, clientName: 'person-setup:desktop-app' });
    const outcome = (operation: string, args: Record<string, unknown>) =>
      app.request(operation, args).then(
        () => 'ok',
        (error: unknown) => (error as { details?: { reason?: string } }).details?.reason ?? 'no reason',
      );
    const wrong = '0'.repeat(64);
    assert.equal(await outcome('rule-approve', { approvalId: ruleOn.approvalId, digest: wrong }), 'DIGEST_MISMATCH');
    assert.equal(await outcome('rule-approve', { approvalId: ruleOn.approvalId, digest: ruleOn.binding.digest }), 'ok');
    assert.equal(
      await outcome('rule-approve', { approvalId: ruleOn.approvalId, digest: ruleOn.binding.digest }),
      'APPROVAL_NOT_WAITING',
    );
    const switchOn = (await harness.control.request('enable-all')) as {
      approvalId: string;
      binding: { digest: string };
    };
    assert.equal(
      await outcome('enable-all-approve', { approvalId: switchOn.approvalId, digest: wrong }),
      'DIGEST_MISMATCH',
    );
    assert.equal(
      await outcome('enable-all-approve', { approvalId: switchOn.approvalId, digest: switchOn.binding.digest }),
      'ok',
    );
    assert.equal(
      await outcome('enable-all-approve', { approvalId: switchOn.approvalId, digest: switchOn.binding.digest }),
      'APPROVAL_NOT_WAITING',
    );
    const lines = (
      (await openCore({ pathOverrides: { stateDir, configDir } }).audit.tail({ limit: 100 })) as unknown as Line[]
    )
      .filter((line) => line.operation === 'events.ruleApprove' || line.operation === 'events.enableAllApprove')
      .map((line) => [line.operation, line.outcome, line.reason ?? null]);
    assert.deepEqual(lines, [
      ['events.ruleApprove', 'refused', 'DIGEST_MISMATCH'],
      ['events.ruleApprove', 'ok', null],
      ['events.ruleApprove', 'refused', 'APPROVAL_NOT_WAITING'],
      ['events.enableAllApprove', 'refused', 'DIGEST_MISMATCH'],
      ['events.enableAllApprove', 'ok', null],
      ['events.enableAllApprove', 'refused', 'APPROVAL_NOT_WAITING'],
    ]);
  });
});
