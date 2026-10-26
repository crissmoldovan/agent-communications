import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Security review of 0.33.0, finding 10: person-only commands an agent has no tool for refused only inside the event
 * service's MCP server, so an agent's own shell could still run them. `integration show` (both kinds) and
 * `session-queue list|drop` now refuse an agent's marker too, and `rule analyse` — which spends the person's model key —
 * is taken only from the Agent Comms app (attested on macOS) or an interactive terminal, as `provider key set` is. All
 * of it is a speed bump against agents, not a boundary against code running as the person.
 */

const APPROVAL_EXIT = new CommsError('APPROVAL_REQUIRED', 'x').exitCode;
const NOT_RUNNING_EXIT = new CommsError('NOT_FOUND', 'x').exitCode;

async function cli(
  stateDir: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly tty?: boolean;
    readonly stdin?: string;
    readonly desktopOrigin?: () => Promise<DesktopOrigin>;
  } = {},
): Promise<{ readonly code: number; readonly stderr: string }> {
  const stdin = Object.assign(new PassThrough(), { isTTY: options.tty === true });
  stdin.end(options.stdin ?? '');
  const stdout = Object.assign(new PassThrough(), { isTTY: options.tty === true });
  const stderr = Object.assign(new PassThrough(), { isTTY: options.tty === true });
  let err = '';
  stdout.resume();
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const code = await run(['--state-dir', stateDir, ...args], {
    env: options.env ?? {},
    streams: { stdin, stdout, stderr },
    ...(options.desktopOrigin === undefined ? {} : { desktopOrigin: options.desktopOrigin }),
  });
  return { code, stderr: err };
}

test('PERSON-SHELL: integration show and session-queue list|drop refuse an agent’s shell, before any owner is asked', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-person-shell-');
  try {
    for (const args of [
      ['integration', 'show', 'linear', '--json'],
      ['integration', 'show', 'agent-sessions', '--json'],
      ['session-queue', 'list', '--json'],
      ['session-queue', 'drop', '0f8fad5b-d9cb-469f-a165-70867728950e', '--json'],
    ]) {
      for (const marker of ['CLAUDECODE', 'CODEX_SANDBOX', 'CURSOR_AGENT']) {
        const ran = await cli(stateDir, args, { env: { [marker]: '1' } });
        assert.equal(ran.code, APPROVAL_EXIT, `${args.join(' ')} with ${marker}: ${ran.stderr}`);
        assert.match(ran.stderr, /only a person can .*, in the app or at their terminal, not an agent/u);
      }
      // Without a marker the command goes on to the owner, which is not running here.
      const person = await cli(stateDir, args);
      assert.notEqual(person.code, APPROVAL_EXIT, `${args.join(' ')} for a person: ${person.stderr}`);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('PERSON-SHELL: rule analyse is taken only from the app, attested on macOS, or a terminal whose output the person reads', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-person-analyse-');
  const args = ['rule', 'analyse', 'invoices', '--json'];
  const origin = (value: DesktopOrigin) => async () => value;
  try {
    // A marker-stripped pipe the app did not start (macOS): refused before anything is read or sent.
    for (const reason of ['not-agent-comms', 'test-app-with-real-profile']) {
      const ran = await cli(stateDir, args, { desktopOrigin: origin({ ok: false, reason }) });
      assert.equal(ran.code, APPROVAL_EXIT, `${reason}: ${ran.stderr}`);
      assert.match(
        ran.stderr,
        /only a person can analyse a rule: in the Agent Comms app, or at an interactive terminal/u,
      );
    }
    const marked = await cli(stateDir, args, { env: { CLAUDECODE: '1' } });
    assert.equal(marked.code, APPROVAL_EXIT, marked.stderr);
    // The attested app, a test build for its own profile, Windows and Linux (unattested, as provider key set takes
    // them), and a terminal — even with a draft piped in — each go on to the owner, which is not running here.
    for (const [what, options] of [
      ['the release app', { desktopOrigin: origin({ ok: true, build: 'release', identifier: 'x' }) }],
      ['the test build', { desktopOrigin: origin({ ok: true, build: 'test', identifier: 'x' }) }],
      ['Windows or Linux', { desktopOrigin: origin({ ok: false, reason: 'unattested-platform' }) }],
      [
        'a terminal',
        {
          tty: true,
          desktopOrigin: async (): Promise<DesktopOrigin> => {
            throw new Error('a terminal asks no attestation');
          },
        },
      ],
    ] as const) {
      const ran = await cli(stateDir, args, options);
      assert.equal(ran.code, NOT_RUNNING_EXIT, `${what}: ${ran.stderr}`);
    }
    const piped = await cli(stateDir, ['rule', 'analyse', 'invoices', '--draft', '-', '--json'], {
      tty: false,
      stdin: '{}',
      desktopOrigin: origin({ ok: false, reason: 'not-agent-comms' }),
    });
    assert.equal(piped.code, APPROVAL_EXIT, 'a draft piped in by a process the app did not start is refused');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
