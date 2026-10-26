import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin, openCore, TEST_PROFILE_MARKER } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { JUDGE_KIND_LOCAL_ENDPOINT } from '../src/domain/lifecycle.ts';
import { DISABLE_ALL_SAID } from '../src/operations/disable-all.ts';
import {
  DAVID,
  dryRun,
  type LaneHarness,
  RULE,
  rule,
  structured,
  tool,
  withLaneOwner,
} from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Events → Service, Switch on… (0.34.0 design B4): `enable-all` prepares the standing approval that starts collection,
 * the app shows its preview, and — only when the person presses Approve — `collection approve <approval-id> --digest
 * <digest>` approves exactly that activation, for the digest the preview showed, on the app channel, as `rule approve`
 * does for a rule's. It is the person's: refused to an agent's shell, the event service's MCP server, a pipe the app did
 * not start and, on Windows and Linux, an origin nothing attests; at a terminal `approve <approval-id>` still asks for
 * the challenge, unchanged.
 */

const APPROVAL_EXIT = new CommsError('APPROVAL_REQUIRED', 'x').exitCode;
const USAGE_EXIT = new CommsError('USAGE', 'x').exitCode;
const VOID_EXIT = new CommsError('APPROVAL_VOID', 'x').exitCode;

/** The release app, attested as the process that started the CLI (core's `desktopAppOrigin`, injected here). */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});
const TEST_BUILD = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'test',
  identifier: 'com.cueplusplus.agentcomms.test',
});
const UNATTESTED = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'unattested-platform' });

const PLACEHOLDER = `ap_${'0'.repeat(26)}`;
const ZEROES = '0'.repeat(64);

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the CLI as the app does: stdin a pipe, never a TTY, started by `desktopOrigin`. With `typeChallenge` it is an
 * interactive terminal instead, and the person types back the challenge the terminal flow shows them.
 */
async function cli(
  stateDir: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly desktopOrigin?: () => Promise<DesktopOrigin>;
    readonly tty?: boolean;
    readonly typeChallenge?: boolean;
  } = {},
): Promise<Ran> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const tty = options.tty === true || options.typeChallenge === true;
  let out = '';
  let err = '';
  let typed = false;
  stdout.on('data', (chunk) => {
    out += chunk;
    const asked = /Type this approval challenge: (\S+)\n> /u.exec(out);
    if (options.typeChallenge === true && asked !== null && !typed) {
      typed = true;
      stdin.write(`${asked[1]}\n`);
    }
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  if (options.typeChallenge !== true) stdin.end('');
  const code = await run(['--state-dir', stateDir, ...args], {
    env: options.env ?? {},
    desktopOrigin: options.desktopOrigin ?? ATTESTED,
    streams: {
      stdin: Object.assign(stdin, { isTTY: tty }),
      stdout: Object.assign(stdout, { isTTY: tty }),
      stderr: Object.assign(stderr, { isTTY: tty }),
    },
  });
  stdin.end();
  await new Promise((resolve) => setImmediate(resolve));
  return { code, stdout: out, stderr: err };
}

interface Prepared {
  readonly intentId: string;
  readonly approvalId: string;
  readonly binding: { readonly digest: string; readonly activationKind: string };
  readonly kind: string;
  readonly status: string;
}

/** A dry-run target and a rule on the fake mailbox, approved as the harness does: on, but collection still off. */
async function ruleOn(harness: LaneHarness): Promise<void> {
  await harness.control.request('target-add', { document: dryRun });
  await harness.control.request('rule-create', { document: rule(1, [dryRun]) });
  await harness.approve(1);
}

async function prepare(stateDir: string): Promise<Prepared> {
  const ran = await cli(stateDir, ['--json', 'enable-all']);
  assert.equal(ran.code, 0, ran.stderr);
  return JSON.parse(ran.stdout) as Prepared;
}

async function switchedOn(stateDir: string): Promise<boolean> {
  const ran = await cli(stateDir, ['--json', 'status']);
  assert.equal(ran.code, 0, ran.stderr);
  return (JSON.parse(ran.stdout) as { enabled?: boolean }).enabled === true;
}

test('collection approve refuses an agent, the MCP server, a pipe the app did not start and bad words, before the owner', async () => {
  const stateDir = await shortTempDir('aev-enable-approve-refuse-');
  const args = ['collection', 'approve', PLACEHOLDER, '--digest', ZEROES];
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT']) {
    const ran = await cli(stateDir, args, { env: { [marker]: '1' } });
    assert.equal(ran.code, APPROVAL_EXIT, `under ${marker}: ${ran.stderr}`);
    assert.match(
      ran.stderr,
      /only a person can switch the event service on, in the app or at their terminal, not an agent/u,
    );
    assert.equal(ran.stdout, '', 'nothing reached the owner');
  }
  const mcp = await cli(stateDir, args, { env: { AGENTCOMMS_MCP_SERVER: 'events' } });
  assert.equal(mcp.code, APPROVAL_EXIT, mcp.stderr);
  assert.match(mcp.stderr, /approving is for a person, in the app or at a terminal — .*MCP server cannot do it/u);
  for (const reason of ['not-started-by-app', 'unsigned-parent'] as const) {
    const ran = await cli(stateDir, args, { desktopOrigin: async () => ({ ok: false, reason }) });
    assert.equal(ran.code, APPROVAL_EXIT, `${reason}: ${ran.stderr}`);
    assert.match(ran.stderr, /in the Agent Comms app, or at an interactive terminal/u);
  }
  // Windows and Linux attest nothing: the person is sent to their terminal, with the words to type there.
  const unattested = await cli(stateDir, ['--json', ...args], { desktopOrigin: UNATTESTED });
  assert.equal(unattested.code, APPROVAL_EXIT, unattested.stderr);
  assert.equal(
    unattested.stderr,
    `nothing on this platform attests that the Agent Comms app started this, so switch the event service on at your terminal, with the event service's approve ${PLACEHOLDER}, which shows its preview and asks for its challenge\nIn the app, press Do it in Terminal; or run the event service’s command at your own terminal.\n`,
  );
  assert.equal(unattested.stdout, '');
  // Words that are not an approval id or a digest never reach the owner.
  for (const [id, digest] of [
    ['ap_short', ZEROES],
    [PLACEHOLDER, 'not-a-digest'],
    [PLACEHOLDER, ZEROES.toUpperCase().replaceAll('0', 'A')],
  ] as const) {
    const ran = await cli(stateDir, ['collection', 'approve', id, '--digest', digest]);
    assert.equal(ran.code, USAGE_EXIT, `${id} ${digest}: ${ran.stderr}`);
  }
});

test('the app switches the event service on: only the enable-all approval it was shown, for its digest, audited', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    await ruleOn(harness);
    assert.equal(await switchedOn(stateDir), false, 'a rule is on, but collection is switched off');

    // What the app receives from `enable-all --json`: the approval, and the digest its preview binds.
    const prepared = await prepare(stateDir);
    t.diagnostic(`enable-all --json: ${JSON.stringify(prepared)}`);
    assert.deepEqual(Object.keys(prepared).sort(), ['approvalId', 'binding', 'intentId', 'kind', 'status']);
    assert.equal(prepared.kind, 'enable-all');
    assert.equal(prepared.status, 'pending');
    assert.match(prepared.approvalId, /^ap_[0-9A-HJKMNP-TV-Z]{26}$/u);
    assert.match(prepared.binding.digest, /^[0-9a-f]{64}$/u);
    assert.equal(prepared.binding.activationKind, 'enable-all');

    // Another digest than the one shown: nothing is approved.
    const stale = await cli(stateDir, ['collection', 'approve', prepared.approvalId, '--digest', ZEROES]);
    assert.equal(stale.code, VOID_EXIT, stale.stderr);
    assert.match(stale.stderr, /what switching on covers changed after you saw its preview: review it again/u);
    assert.equal(await switchedOn(stateDir), false);

    // Another approval waiting — a judge kind's enablement — is not this one's to approve.
    const kind = (await harness.control.request('enableJudgeKind', { kind: JUDGE_KIND_LOCAL_ENDPOINT })) as Prepared;
    const notEnableAll = await cli(stateDir, [
      'collection',
      'approve',
      kind.approvalId,
      '--digest',
      kind.binding.digest,
    ]);
    assert.equal(notEnableAll.code, APPROVAL_EXIT, notEnableAll.stderr);
    assert.match(notEnableAll.stderr, /this approval does not switch the event service on/u);

    // The owner's wire is the person's, from the app only: any other client, a terminal's origin or an agent window's
    // call is refused, and the unattested origin is sent to the terminal and audited.
    for (const clientName of ['events-cli', 'app-approval-screen', 'terminal-approval', 'person-setup:terminal']) {
      await assert.rejects(
        new EventControlClient({ stateDir, clientName }).request('enable-all-approve', {
          approvalId: prepared.approvalId,
          digest: prepared.binding.digest,
        }),
        (error: unknown) => (error as { code?: string }).code === 'APPROVAL_REQUIRED',
        clientName,
      );
    }
    await assert.rejects(
      new EventControlClient({ stateDir, clientName: 'person-setup:desktop-app' }).request('enable-all-approve', {
        approvalId: prepared.approvalId,
        digest: prepared.binding.digest,
        caller: DAVID,
      }),
      /switching the event service on is for a person, at a terminal or in the app, not an agent window/u,
    );
    await assert.rejects(
      new EventControlClient({ stateDir, clientName: 'person-setup:desktop-app-unattested' }).request(
        'enable-all-approve',
        { approvalId: prepared.approvalId, digest: prepared.binding.digest },
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'APPROVAL_REQUIRED');
        assert.deepEqual((error as { details?: unknown }).details, {
          reason: 'ORIGIN_UNATTESTED',
          approvalId: prepared.approvalId,
        });
        return true;
      },
    );
    // At a terminal the person types the challenge with approve: this path is the app's only, and the owner says so.
    const typed = await cli(stateDir, ['collection', 'approve', prepared.approvalId, '--digest', ZEROES], {
      tty: true,
      desktopOrigin: async () => {
        throw new Error('a terminal asks no attestation');
      },
    });
    assert.equal(typed.code, APPROVAL_EXIT, typed.stderr);
    assert.match(typed.stderr, /switch the event service on with approve <approval-id>, which asks for its challenge/u);
    assert.equal(await switchedOn(stateDir), false, 'none of those switched it on');

    // The person's press: approved on the app channel, and collection is on.
    const approved = await cli(stateDir, [
      '--json',
      'collection',
      'approve',
      prepared.approvalId,
      '--digest',
      prepared.binding.digest,
    ]);
    assert.equal(approved.code, 0, approved.stderr);
    t.diagnostic(`collection approve --json: ${approved.stdout.trim()}`);
    const result = JSON.parse(approved.stdout) as Record<string, unknown>;
    assert.deepEqual(
      { ...result, completion: undefined },
      {
        approvalId: prepared.approvalId,
        approved: true,
        approvedBy: 'desktop-app',
        ruleVersions: [{ ruleId: RULE, ruleVersion: 1 }],
        completion: undefined,
      },
    );
    const completion = result.completion as { intentId: string; status: string; usedAt: string };
    assert.deepEqual([completion.intentId, completion.status], [prepared.intentId, 'completed']);
    assert.equal(Number.isFinite(Date.parse(completion.usedAt)), true);
    assert.equal(await switchedOn(stateDir), true, 'collection is switched on');

    // Collection runs: a new mail reaches the rule's dry-run target.
    harness.mailbox.send('Collected after switching on');
    let delivered = 0;
    for (let index = 0; index < 10 && delivered === 0; index += 1) {
      await harness.tick();
      const rows = JSON.parse((await cli(stateDir, ['--json', 'deliveries', 'list'])).stdout) as unknown[];
      delivered = rows.length;
    }
    assert.ok(delivered > 0, 'the switched-on service collected and delivered the new mail');

    const core = openCore({ pathOverrides: { stateDir, configDir: join(stateDir, '..', 'config') } });
    const disclosure = (await core.approvals.list()).flatMap((entry) =>
      entry.form === 'v2' && entry.record.kind === 'disclosure' && entry.record.approvalId === prepared.approvalId
        ? [entry.record as { state?: string; approvedVia?: string }]
        : [],
    )[0];
    assert.deepEqual([disclosure?.state, disclosure?.approvedVia], ['used', 'app']);

    // The owner's audit says where the person was for each try, and never holds a challenge.
    const lines = (await core.audit.tail({ limit: 100 })).filter(
      (line) => line.operation === 'events.enableAllApprove',
    );
    assert.deepEqual(
      lines.map((line) => [line.outcome, line.reason ?? null, (line.ids as { approvedBy?: string }).approvedBy]),
      [
        ['failed', null, 'desktop-app'],
        ['refused', 'NOT_ENABLE_ALL', 'desktop-app'],
        ['refused', 'PERSON_SETUP_ONLY', undefined],
        ['refused', 'PERSON_SETUP_ONLY', undefined],
        ['refused', 'PERSON_SETUP_ONLY', undefined],
        ['refused', 'AT_TERMINAL', 'terminal'],
        ['refused', 'ORIGIN_UNATTESTED', 'desktop-app (unattested)'],
        ['refused', 'AT_TERMINAL', 'terminal'],
        ['ok', null, 'desktop-app'],
      ],
    );
    assert.deepEqual(lines.at(-1)?.ids, {
      approvalId: prepared.approvalId,
      approvedBy: 'desktop-app',
      ruleVersions: [`${RULE}@1`],
    });
    assert.doesNotMatch(JSON.stringify(lines), /challenge/iu);

    // Used once: the same press again approves nothing.
    const again = await cli(stateDir, [
      'collection',
      'approve',
      prepared.approvalId,
      '--digest',
      prepared.binding.digest,
    ]);
    assert.equal(again.code, VOID_EXIT, again.stderr);
    assert.match(again.stderr, /no longer waiting/u);
  });
});

test('switching on: the attested test build approves as itself; switching off says what it did; the terminal approve is unchanged', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    await ruleOn(harness);

    // The test build, for its own test profile: its folders together, its event service's state folder marked.
    await writeFile(join(stateDir, TEST_PROFILE_MARKER), '');
    const first = await prepare(stateDir);
    const fromTestBuild = await cli(
      stateDir,
      [
        '--config-dir',
        join(stateDir, '..', 'config'),
        '--json',
        'collection',
        'approve',
        first.approvalId,
        '--digest',
        first.binding.digest,
      ],
      { desktopOrigin: TEST_BUILD },
    );
    assert.equal(fromTestBuild.code, 0, fromTestBuild.stderr);
    assert.equal((JSON.parse(fromTestBuild.stdout) as { approvedBy: string }).approvedBy, 'desktop-app (test build)');
    assert.equal(await switchedOn(stateDir), true);

    // Switch off: a tightening, at once, from anywhere, whose result says what it did in plain words.
    const off = await cli(stateDir, ['--json', 'disable-all']);
    assert.equal(off.code, 0, off.stderr);
    t.diagnostic(`disable-all --json: ${off.stdout.trim()}`);
    const offResult = JSON.parse(off.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(offResult).sort(), ['enabled', 'paused', 'said', 'switchGeneration']);
    assert.deepEqual([offResult.enabled, offResult.paused, offResult.said], [false, false, DISABLE_ALL_SAID]);
    assert.equal(await switchedOn(stateDir), false);
    // What it says holds: the rule is kept, still on, for the next switch-on.
    assert.deepEqual(
      ((await harness.control.request('rules-list')) as { version: number; state: string | null }[]).map(
        (row) => `${row.version}:${row.state}`,
      ),
      ['1:active'],
    );
    // An agent may switch off too, over MCP, and reads the same words.
    const david = await harness.window(DAVID);
    const viaMcp = structured(await tool(david, 'events_disable_all'));
    assert.deepEqual([viaMcp.enabled, viaMcp.said], [false, DISABLE_ALL_SAID]);

    // Then on again at the terminal: approve asks for the challenge, as before.
    const second = await prepare(stateDir);
    const typed = await cli(stateDir, ['approve', second.approvalId], {
      typeChallenge: true,
      desktopOrigin: async () => {
        throw new Error('a terminal asks no attestation');
      },
    });
    assert.equal(typed.code, 0, typed.stderr);
    assert.match(typed.stdout, /Type this approval challenge: /u);
    assert.match(typed.stdout, /"status":"completed"/u);
    assert.equal(await switchedOn(stateDir), true, 'the typed challenge switched it on');
    const core = openCore({ pathOverrides: { stateDir, configDir: join(stateDir, '..', 'config') } });
    const vias = (await core.approvals.list()).flatMap((entry) =>
      entry.form === 'v2' &&
      entry.record.kind === 'disclosure' &&
      [first.approvalId, second.approvalId].includes(entry.record.approvalId)
        ? [[entry.record.approvalId, (entry.record as { approvedVia?: string }).approvedVia]]
        : [],
    );
    assert.deepEqual(
      new Map(vias as [string, string][]),
      new Map([
        [first.approvalId, 'app'],
        [second.approvalId, 'terminal'],
      ]),
    );
  });
});
