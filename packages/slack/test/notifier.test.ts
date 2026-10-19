import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ackNotice, type NoticeRunner, type Notifier, openCore } from '@agentcomms/core';
import { SLACK_CALLER } from '../src/caller.ts';
import { SlackContext } from '../src/context.ts';
import { newHarness } from './support/harness.ts';

/**
 * The notice on the person's screen for each standing act (design 2026-10-19-standing-approvals, S10): a Slack context
 * raises it with core's notifier for its platform unless it is given one, and its words are core's `ackNotice`, written
 * nowhere else. Every runner here is injected: no test shows a real notification.
 */

interface Started {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function recordingRunner(started: Started[]): NoticeRunner {
  return async (program, args, env) => {
    started.push({ program, args, env });
  };
}

const NOTICE = ackNotice({ act: 'reaction', text: 'eyes', place: '#eng', standingId: `ap_${'7'.repeat(26)}` });

test("a context made without notify gets the platform's notifier", async () => {
  const harness = await newHarness();
  const core = openCore({ env: harness.env, caller: SLACK_CALLER });
  for (const [platform, extra, program] of [
    ['darwin', {}, '/usr/bin/osascript'],
    ['win32', { SystemRoot: 'C:\\Windows' }, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  ] as const) {
    const started: Started[] = [];
    const context = new SlackContext({
      core,
      env: { ...harness.env, ...extra },
      platform,
      noticeRunner: recordingRunner(started),
    });
    assert.equal(typeof context.notify, 'function', `${platform}: no notifier`);
    assert.deepEqual(await context.notify?.(NOTICE), { raised: true }, platform);
    assert.equal(started.length, 1, `${platform}: the runner was not started once`);
    assert.equal(started[0]?.program, program, platform);
    if (platform === 'darwin') {
      // The text goes as the run handler's arguments, after `--`: never in the script.
      assert.deepEqual(started[0]?.args.slice(-3), ['--', NOTICE.body, NOTICE.title]);
    } else {
      // PowerShell's `-Command` would join an argument into the script: the text goes in the environment.
      assert.equal(started[0]?.env.AGENTCOMMS_NOTICE_BODY, NOTICE.body);
      assert.equal(started[0]?.env.AGENTCOMMS_NOTICE_TITLE, NOTICE.title);
      assert.ok(!started[0]?.args.some((arg) => arg.includes(NOTICE.body)), 'the body is in the script');
    }
  }
});

test('a context given notify null raises none, and one given a notifier keeps it', async () => {
  const harness = await newHarness();
  const core = openCore({ env: harness.env, caller: SLACK_CALLER });
  const started: Started[] = [];
  const none = new SlackContext({ core, env: harness.env, platform: 'darwin', notify: null });
  assert.equal(none.notify, undefined);
  const given: Notifier = async () => ({ raised: true });
  const kept = new SlackContext({
    core,
    env: harness.env,
    platform: 'darwin',
    notify: given,
    noticeRunner: recordingRunner(started),
  });
  assert.equal(kept.notify, given);
  await kept.notify?.(NOTICE);
  assert.equal(started.length, 0, 'the default ran beside the notifier given');
});

const PACKAGES = fileURLToPath(new URL('../..', import.meta.url));

/** Every source file under `directory`, skipping what a build or an install writes. */
async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.(?:ts|mts|js|mjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("a standing act's notice is in core's words, written nowhere else", async () => {
  // The words the person reads on their screen have one home, `ackNotice`: a second copy drifts from it unseen.
  const writers: string[] = [];
  for (const name of await readdir(PACKAGES)) {
    if (name === 'core') continue;
    let files: string[];
    try {
      files = await sources(join(PACKAGES, name, 'src'));
    } catch {
      continue;
    }
    for (const file of files) {
      if ((await readFile(file, 'utf8')).includes('Your agent sent')) writers.push(relative(PACKAGES, file));
    }
  }
  assert.deepEqual(writers, []);
});
