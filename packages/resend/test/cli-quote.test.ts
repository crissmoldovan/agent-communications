import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { agentMarkerHint, isCommand, openCore } from '@agentcomms/core';
import { RESEND_CALLER } from '../src/caller.ts';
import { run } from '../src/cli/program.ts';
import { ResendContext } from '../src/context.ts';
import { assertNoBareCommand, resendHandoffs, resendInline } from './support/handoffs.ts';

/**
 * The command printed for a person to add a key has to fit the shell on the platform running this CLI (CUE-398) — and,
 * since CUE-403, it is this installation's own: this Node, Resend's entry, the folders pinned, then the words.
 */

interface ErrorEnvelope {
  error?: { hint?: string };
}

test('the Resend operation context carries an explicitly selected platform', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-resend-platform-')));
  const env = { AGENT_COMMS_CONFIG_DIR: join(root, 'config') };
  const context = new ResendContext({ core: openCore({ env, caller: RESEND_CALLER }), env, platform: 'win32' });
  assert.equal(context.platform, 'win32');
  assert.equal(context.handoffs.platform, 'win32', 'its commands are quoted for that shell');
});

async function addAccount(
  domain: string,
  platform: NodeJS.Platform,
): Promise<{ hint: string; core: ReturnType<typeof openCore> }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-resend-quote-')));
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);
  const env = {
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_UPDATE_CHECK: 'off',
    HOME: root,
    USERPROFILE: root,
    NO_COLOR: '1',
    CLAUDECODE: '1',
    // This process's PATH, as the harness gives it: a command names this Node from it (CUE-492), and the expected
    // commands in `support/handoffs.ts` are made from it too.
    PATH: process.env.PATH ?? '',
  };
  const core = openCore({ env, caller: RESEND_CALLER });
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(['--json', 'account', 'add', 'acme/resend', '--domain', domain], {
    core,
    env,
    platform,
    fetch: async () => {
      throw new Error('the key refusal must happen before Resend is called');
    },
    streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
  });
  assert.equal(code, 77, stdout);
  return { hint: String((JSON.parse(stdout) as ErrorEnvelope).error?.hint), core };
}

test('the hand-off command quotes a spaced word on POSIX and prints words instead of an unsafe Windows line', async () => {
  const words = (domain: string) => ['account', 'add', 'acme/resend', '--domain', domain];
  const posix = await addAccount('two words.test', 'darwin');
  assert.equal(
    posix.hint,
    `Ask the user to run ${resendInline(posix.core, words('two words.test'))} in their own terminal. Never paste a key into a chat: the transcript keeps it. ${agentMarkerHint('CLAUDECODE', process.platform)}`,
  );
  assert.match(posix.hint, / account add acme\/resend --domain 'two words\.test'`/);

  const windows = await addAccount('client%domain.test', 'win32');
  const add = resendHandoffs(windows.core.paths, 'win32').own(words('client%domain.test'));
  assert.ok(isCommand(add) && add.line === null, 'no Windows line passes a % alike to every shell');
  assert.match(windows.hint, /"account","add","acme\/resend","--domain","client\\u0025domain\.test"\]/);
  assert.match(windows.hint, /cannot be quoted the same way for cmd\.exe and for PowerShell/);
  assert.ok(windows.hint.includes(resendInline(windows.core, words('client%domain.test'), 'win32')), windows.hint);
  for (const { hint } of [posix, windows]) assertNoBareCommand(hint);
});
