import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin, openCore } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { JUDGE_KIND_LOCAL_ENDPOINT } from '../src/domain/lifecycle.ts';
import { DAY, dryRun, RULE, rule, withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * `rule approve <approval-id> --digest <digest>` and the documents read from stdin (0.33.0 design §3.1): the desktop
 * app's rule editor hands the rule it made, and each target it needs, to `rule create|update -` and `target add|update
 * -` on stdin, prepares the activation with `rule enable`, shows its preview, and — only when the person presses Approve
 * — approves that activation, for exactly the digest the preview showed, on the app channel, as judge setup does.
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

const PLACEHOLDER = `ap_${'0'.repeat(26)}`;
const ZEROES = '0'.repeat(64);

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI as the app does: stdin a pipe holding `stdin`, never a TTY, started by `desktopOrigin`. */
async function cli(
  stateDir: string,
  args: readonly string[],
  options: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly desktopOrigin?: () => Promise<DesktopOrigin>;
    readonly tty?: boolean;
  } = {},
): Promise<Ran> {
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const tty = options.tty === true;
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk;
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await run(['--state-dir', stateDir, ...args], {
    env: options.env ?? {},
    desktopOrigin: options.desktopOrigin ?? ATTESTED,
    streams: {
      stdin: Object.assign(stdin, { isTTY: tty }),
      stdout: Object.assign(stdout, { isTTY: tty }),
      stderr: Object.assign(stderr, { isTTY: tty }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, stdout: out, stderr: err };
}

test('rule approve refuses an agent, the MCP server and a pipe the app did not start, before the owner', async () => {
  const stateDir = await shortTempDir('aev-rule-approve-refuse-');
  const args = ['rule', 'approve', PLACEHOLDER, '--digest', ZEROES];
  try {
    for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT']) {
      const ran = await cli(stateDir, args, { env: { [marker]: '1' } });
      assert.equal(ran.code, APPROVAL_EXIT, `under ${marker}: ${ran.stderr}`);
      assert.match(ran.stderr, /only a person can approve a workflow, in the app or at their terminal, not an agent/u);
      assert.match(ran.stderr, /Ask the person to do it in the app: Events → Workflows, Review and approve\./u);
      assert.equal(ran.stdout, '', 'nothing reached the owner');
    }
    const mcp = await cli(stateDir, args, { env: { AGENTCOMMS_MCP_SERVER: 'events' } });
    assert.equal(mcp.code, APPROVAL_EXIT, mcp.stderr);
    assert.match(mcp.stderr, /MCP server cannot do it/u);
    for (const reason of ['not-started-by-app', 'unsigned-parent'] as const) {
      const ran = await cli(stateDir, args, { desktopOrigin: async () => ({ ok: false, reason }) });
      assert.equal(ran.code, APPROVAL_EXIT, `${reason}: ${ran.stderr}`);
      assert.match(ran.stderr, /in the Agent Comms app, or at an interactive terminal/u);
    }
    // Words that are not an approval id or a digest never reach the owner.
    for (const [id, digest] of [
      ['ap_short', ZEROES],
      [PLACEHOLDER, 'not-a-digest'],
      [PLACEHOLDER, ZEROES.toUpperCase().replaceAll('0', 'A')],
    ] as const) {
      const ran = await cli(stateDir, ['rule', 'approve', id, '--digest', digest]);
      assert.equal(ran.code, USAGE_EXIT, `${id} ${digest}: ${ran.stderr}`);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a document of - is read from stdin, and must be one JSON value', async () => {
  const stateDir = await shortTempDir('aev-stdin-doc-');
  try {
    for (const args of [
      ['rule', 'create', '-'],
      ['rule', 'update', '-'],
      ['target', 'add', '-'],
      ['target', 'update', '-'],
    ]) {
      const empty = await cli(stateDir, args, { stdin: '' });
      assert.equal(empty.code, USAGE_EXIT, `${args.join(' ')}: ${empty.stderr}`);
      assert.match(empty.stderr, /document is required, on stdin/u);
      const broken = await cli(stateDir, args, { stdin: '{"ruleId":' });
      assert.equal(broken.code, USAGE_EXIT, broken.stderr);
      assert.match(broken.stderr, /document must be valid JSON/u);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('the app approves only the rule activation it was shown, for its digest, and the old version runs until then', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    const json = async (args: readonly string[], stdin?: string): Promise<Record<string, unknown>> => {
      const ran = await cli(stateDir, ['--json', ...args], stdin === undefined ? {} : { stdin });
      assert.equal(ran.code, 0, `${args.join(' ')}: ${ran.stderr}`);
      return JSON.parse(ran.stdout) as Record<string, unknown>;
    };
    const states = async () =>
      ((await json(['rules', 'list'])) as unknown as { version: number; state: string | null }[]).map(
        (row) => `${row.version}:${row.state}`,
      );

    // The target and the rule arrive on stdin, as the app sends them.
    const added = await json(['target', 'add', '-'], JSON.stringify(dryRun));
    assert.equal(added.objectId, 'dry-david');
    const created = await json(['rule', 'create', '-'], JSON.stringify(rule(1, [dryRun])));
    assert.equal(created.objectId, RULE);
    assert.equal(created.version, 1);

    const enabled = await json(['rule', 'enable', RULE, '1']);
    const approvalId = enabled.approvalId as string;
    const digest = (enabled.binding as { digest: string }).digest;
    assert.match(approvalId, /^ap_/u);
    assert.match(digest, /^[0-9a-f]{64}$/u);

    // Another digest than the one shown: nothing is approved.
    const stale = await cli(stateDir, ['rule', 'approve', approvalId, '--digest', ZEROES]);
    assert.equal(stale.code, VOID_EXIT, stale.stderr);
    assert.match(stale.stderr, /the workflow changed after you saw its preview/u);
    assert.deepEqual(await states(), ['1:null']);

    // The person's press: approved on the app channel, and on.
    const approved = await json(['rule', 'approve', approvalId, '--digest', digest]);
    assert.deepEqual(
      { ...approved, completion: undefined },
      { approvalId, ruleId: RULE, version: 1, approved: true, approvedBy: 'desktop-app', completion: undefined },
    );
    assert.equal((approved.completion as { status: string }).status, 'completed');
    assert.deepEqual(await states(), ['1:active']);
    const core = openCore({ pathOverrides: { stateDir, configDir: join(stateDir, '..', 'config') } });
    const disclosure = (await core.approvals.list()).flatMap((entry) =>
      entry.form === 'v2' && entry.record.kind === 'disclosure' && entry.record.approvalId === approvalId
        ? [entry.record]
        : [],
    )[0];
    assert.equal(disclosure?.state, 'used');
    assert.equal((disclosure as { approvedVia?: string } | undefined)?.approvedVia, 'app');

    // The owner's audit line says where the person was, and never holds a challenge.
    const approvals = (await core.audit.tail({ limit: 50 })).filter((line) => line.operation === 'events.ruleApprove');
    assert.equal(approvals.at(-1)?.outcome, 'ok');
    assert.deepEqual(approvals.at(-1)?.ids, { approvalId, ruleId: RULE, ruleVersion: '1', approvedBy: 'desktop-app' });

    // Used once: the same press again approves nothing.
    const again = await cli(stateDir, ['rule', 'approve', approvalId, '--digest', digest]);
    assert.equal(again.code, VOID_EXIT, again.stderr);
    assert.match(again.stderr, /no longer waiting/u);

    // A new version waits for the person while the old one keeps running.
    const longer = { ...dryRun, version: 2, retentionMs: DAY / 2 };
    await json(['target', 'update', '-'], JSON.stringify(longer));
    await json(['rule', 'update', '-'], JSON.stringify(rule(2, [longer])));
    const next = await json(['rule', 'enable', RULE, '2']);
    assert.deepEqual(await states(), ['1:active', '2:null']);
    await json(['rule', 'approve', next.approvalId as string, '--digest', (next.binding as { digest: string }).digest]);
    // The owner's ticks finish draining the old version before it swaps (D2).
    for (let index = 0; index < 10 && (await states()).join() !== '1:superseded,2:active'; index += 1)
      await harness.tick();
    assert.deepEqual(await states(), ['1:superseded', '2:active']);

    // The owner's wire is the person's from the app only: any other client, or a terminal's origin, is refused.
    for (const [clientName, code] of [
      ['events-cli', 'APPROVAL_REQUIRED'],
      ['app-approval-screen', 'APPROVAL_REQUIRED'],
      ['person-setup:terminal', 'APPROVAL_REQUIRED'],
    ] as const) {
      await assert.rejects(
        new EventControlClient({ stateDir, clientName }).request('rule-approve', {
          approvalId: next.approvalId,
          digest: ZEROES,
        }),
        (error: unknown) => (error as { code?: string }).code === code,
        clientName,
      );
    }

    // At a terminal the person types the challenge, with approve: this path is the app's only, and the owner says so.
    const typed = await cli(stateDir, ['rule', 'approve', next.approvalId as string, '--digest', ZEROES], {
      tty: true,
      desktopOrigin: async () => {
        throw new Error('a terminal asks no attestation');
      },
    });
    assert.equal(typed.code, APPROVAL_EXIT, typed.stderr);
    assert.match(typed.stderr, /approve a workflow with approve <approval-id>, which asks for its challenge/u);

    // Anything but a rule's activation is approved elsewhere.
    const kind = await json(['judge', 'kind', 'enable', JUDGE_KIND_LOCAL_ENDPOINT]);
    const refused = await cli(stateDir, [
      'rule',
      'approve',
      kind.approvalId as string,
      '--digest',
      (kind.binding as { digest: string }).digest,
    ]);
    assert.equal(refused.code, APPROVAL_EXIT, refused.stderr);
    assert.match(refused.stderr, /only a workflow's activation is approved here/u);
  });
});
