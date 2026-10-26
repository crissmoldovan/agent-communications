import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin, openCore } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { dryRun, RULE, rule, withLaneOwner } from './support/lane-harness.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Security review of 0.33.0, finding 2 (SEC-3): on Windows and Linux nothing attests that the Agent Comms app started a
 * command, so `rule approve` took any process without an agent's marker as the app — an agent could prepare a rule's
 * activation over MCP and approve it with `env -u CLAUDECODE agent-events rule approve …`, recorded `approvedVia: app`.
 * Now an unattested origin is sent to the terminal, by the CLI and by the owner alike, with `APPROVAL_REQUIRED`, its
 * own reason and the exact command; only the attested app approves in the app, and each try is audited with where the
 * person was.
 */

const APPROVAL_EXIT = new CommsError('APPROVAL_REQUIRED', 'x').exitCode;

async function cliAs(
  stateDir: string,
  args: readonly string[],
  desktopOrigin: () => Promise<DesktopOrigin>,
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
  // Markers stripped (env = {}), stdin a pipe: what the review's agent shell ran.
  const code = await run(['--state-dir', stateDir, ...args], {
    env: {},
    desktopOrigin,
    streams: { stdin, stdout, stderr },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

test('SEC-3: on Windows and Linux an agent-prepared rule activation is never approved by a marker-stripped process', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    // The agent, over MCP or the control socket, prepares everything: target, rule, activation.
    await harness.control.request('target-add', { document: dryRun });
    await harness.control.request('rule-create', { document: rule(1, [dryRun]) });
    const planned = (await harness.control.request('rule-enable', { ruleId: RULE, version: 1 })) as {
      approvalId: string;
      binding: { digest: string };
    };
    const unattested = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'unattested-platform' });
    const ran = await cliAs(
      stateDir,
      ['--json', 'rule', 'approve', planned.approvalId, '--digest', planned.binding.digest],
      unattested,
    );
    assert.equal(ran.code, APPROVAL_EXIT, ran.err);
    assert.match(ran.err, /approve the rule at your terminal with agent-events approve ap_[0-9A-Z]{26}/u);
    assert.ok(ran.err.includes(`agent-events approve ${planned.approvalId}`), 'the exact command');
    assert.match(ran.err, /nothing on this platform attests that the Agent Comms app started this/u);

    // The owner refuses the same origin, should any client say it, and audits where the person was.
    await assert.rejects(
      new EventControlClient({ stateDir, clientName: 'person-setup:desktop-app-unattested' }).request('rule-approve', {
        approvalId: planned.approvalId,
        digest: planned.binding.digest,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'APPROVAL_REQUIRED');
        assert.equal((error as { details?: { reason?: string } }).details?.reason, 'ORIGIN_UNATTESTED');
        return true;
      },
    );
    const core = openCore({ pathOverrides: { stateDir, configDir: join(stateDir, '..', 'config') } });
    const record = async () =>
      (await core.approvals.list()).flatMap((entry) =>
        entry.form === 'v2' && entry.record.kind === 'disclosure' && entry.record.approvalId === planned.approvalId
          ? [entry.record as { state?: string; approvedVia?: string }]
          : [],
      )[0];
    assert.notEqual((await record())?.state, 'used', 'nothing was approved');
    const lines = async () =>
      (await core.audit.tail({ limit: 50 })).filter((line) => line.operation === 'events.ruleApprove');
    assert.deepEqual(
      (await lines()).map((line) => [line.outcome, line.reason, (line.ids as { approvedBy?: string }).approvedBy]),
      [['refused', 'ORIGIN_UNATTESTED', 'desktop-app (unattested)']],
      'the owner audits the refusal with the real origin',
    );

    // The attested test build, for its own profile, approves — recorded via the app, audited as the test build.
    const testBuild = async (): Promise<DesktopOrigin> => ({
      ok: true,
      build: 'test',
      identifier: 'com.cueplusplus.agentcomms.test',
    });
    const approved = await cliAs(
      stateDir,
      ['--json', 'rule', 'approve', planned.approvalId, '--digest', planned.binding.digest],
      testBuild,
    );
    assert.equal(approved.code, 0, approved.err);
    assert.equal((JSON.parse(approved.out) as { approvedBy: string }).approvedBy, 'desktop-app (test build)');
    assert.deepEqual([(await record())?.state, (await record())?.approvedVia], ['used', 'app']);
    const last = (await lines()).at(-1);
    assert.deepEqual(
      [last?.outcome, (last?.ids as { approvedBy?: string } | undefined)?.approvedBy],
      ['ok', 'desktop-app (test build)'],
    );
  });
});
