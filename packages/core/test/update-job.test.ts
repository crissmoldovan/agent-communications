import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { gatedChange } from '../src/change-flow.ts';
import { main } from '../src/cli.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { type CoreMcpOptions, createCoreMcpServer } from '../src/mcp/server.ts';
import { nodeProgram } from '../src/node-program.ts';
import { doctor } from '../src/operations/maintenance.ts';
import { updateJobChange } from '../src/operations/update-job.ts';
import { updateLevelChange } from '../src/operations/update-settings.ts';
import {
  backgroundJobAtRun,
  inspectUpdateJob,
  installUpdateJob,
  launchAgentPlist,
  removeUpdateJob,
  systemdService,
  systemdTimer,
  type UpdateJobDeps,
  type UpdateJobRunner,
  updateJobCommand,
  updateJobContext,
  updateJobInstalled,
  updateJobMarkerPath,
  windowsQueryScript,
  windowsRegisterScript,
  windowsUnregisterScript,
} from '../src/update-job.ts';
import { coreCommand, coreInline } from './helpers/handoffs.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The per-user background update job (design 2026-10-16 U4, U8; plan Track C): one writer per platform, set up with
 * the person's yes, removed at once, reported by the doctor.
 *
 * Nothing here schedules a real job. Every command goes to a runner the test hands in, which records it and answers as
 * the test says; every file is under a temporary home. The platform is chosen by the test, so each platform's writer
 * runs on every machine.
 */

interface Call {
  program: string;
  args: readonly string[];
}

/** A runner that records each command and answers with `answer` (exit 0 and no output by default). */
function recorder(answer: (call: Call) => { status?: number; stdout?: string; stderr?: string } = () => ({})) {
  const calls: Call[] = [];
  const run: UpdateJobRunner = async (program, args) => {
    const call = { program, args: [...args] };
    calls.push(call);
    const { status = 0, stdout = '', stderr = '' } = answer(call);
    return { status, stdout, stderr };
  };
  return { calls, run };
}

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  launcher: string;
}

/** A home of the test's own, with core's folders under it and the stable launcher there, as Track B writes it. */
function machine(prefix = 'comms-update-job-', options: { launcher?: boolean } = {}): Machine {
  const home = tempDir(prefix);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: join(home, 'bin'),
    SystemRoot: 'C:\\Windows',
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
    NO_COLOR: '1',
  };
  mkdirSync(env.AGENT_COMMS_CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(env.AGENT_COMMS_CONFIG_DIR, 'config.json'),
    `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`,
  );
  const core = openCore({ env, caller: CORE_CALLER });
  const launcher = join(core.paths.dataDir, 'launch', 'core');
  if (options.launcher !== false) {
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
  }
  return { home, env, core, launcher };
}

/** The four folder pins every registration carries (CUE-403), which the job carries too, before its command. */
function pins(core: Core): string[] {
  const { configDir, stateDir, dataDir, secretsDir } = core.paths;
  return ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir];
}

const FIXED = new Date('2026-10-16T09:00:00.000Z');
/** The Node a Windows task starts the launcher with, as the test names it. */
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const deps = (run: UpdateJobRunner, over: Partial<UpdateJobDeps> = {}): UpdateJobDeps => ({
  run,
  uid: 501,
  random: () => 0.5,
  now: () => FIXED,
  node: NODE,
  ...over,
});

const plistOf = (m: Machine) => join(m.home, 'Library', 'LaunchAgents', 'com.agentcomms.update.plist');
const unitsOf = (m: Machine) => {
  const directory = join(m.home, '.config', 'systemd', 'user');
  return { service: join(directory, 'agentcomms-update.service'), timer: join(directory, 'agentcomms-update.timer') };
};
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
/** The script a PowerShell call was handed, decoded from its `-EncodedCommand`. */
function scriptOf(call: Call): string {
  assert.equal(call.program, POWERSHELL);
  assert.deepEqual(call.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(call.args.length, 5);
  return Buffer.from(String(call.args[4]), 'base64').toString('utf16le');
}

// ── What each platform's job is, exactly ────────────────────────────────────────────────────────────────────────

test('macOS: the LaunchAgent, exactly — hour 10, the minute given, never at load, every word escaped', () => {
  const command = ['/srv/jo/Data & Co/launch/core', '--config-dir', '/srv/jo/<config>', 'update', '--background'];
  assert.equal(
    launchAgentPlist(command, 7),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>Label</key>',
      '\t<string>com.agentcomms.update</string>',
      '\t<key>ProgramArguments</key>',
      '\t<array>',
      '\t\t<string>/srv/jo/Data &amp; Co/launch/core</string>',
      '\t\t<string>--config-dir</string>',
      '\t\t<string>/srv/jo/&lt;config&gt;</string>',
      '\t\t<string>update</string>',
      '\t\t<string>--background</string>',
      '\t</array>',
      '\t<key>StartCalendarInterval</key>',
      '\t<dict>',
      '\t\t<key>Hour</key>',
      '\t\t<integer>10</integer>',
      '\t\t<key>Minute</key>',
      '\t\t<integer>7</integer>',
      '\t</dict>',
      '\t<key>RunAtLoad</key>',
      '\t<false/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );
  assert.throws(() => launchAgentPlist(command, 60), /minute/);
});

test('Linux: the service and the timer, exactly — daily, persistent, an hour of random delay, every word quoted', () => {
  const command = ['/srv/jo/50% "off"/launch/core', '--data-dir', '/srv/jo/$HOME\\x', 'update', '--background'];
  assert.equal(
    systemdService(command),
    [
      '# Written by agent-communications. Its update --background-job off removes it.',
      '[Unit]',
      'Description=agent-communications: install verified releases in the background',
      '',
      '[Service]',
      'Type=oneshot',
      'ExecStart="/srv/jo/50%% \\"off\\"/launch/core" "--data-dir" "/srv/jo/$$HOME\\\\x" "update" "--background"',
      '',
    ].join('\n'),
  );
  assert.equal(
    systemdTimer(),
    [
      '# Written by agent-communications. Its update --background-job off removes it.',
      '[Unit]',
      'Description=agent-communications: install verified releases in the background, daily',
      '',
      '[Timer]',
      'OnCalendar=daily',
      'Persistent=true',
      'RandomizedDelaySec=1h',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
  );
});

test('Windows: the task scripts, exactly — daily, an hour of random delay, when available, on battery, no elevation', () => {
  const command = [
    'D:\\Profiles\\Jo Example\\data\\launch\\core',
    '--config-dir',
    'D:\\Profiles\\Jo Example\\config\\',
    '--state-dir',
    "D:\\Profiles\\O'Brien\\state",
    'update',
    '--background',
  ];
  assert.equal(
    windowsRegisterScript(command),
    [
      "$ErrorActionPreference = 'Stop'",
      "$action = New-ScheduledTaskAction -Execute 'D:\\Profiles\\Jo Example\\data\\launch\\core' -Argument '--config-dir \"D:\\Profiles\\Jo Example\\config\\\\\" --state-dir D:\\Profiles\\O''Brien\\state update --background'",
      "$trigger = New-ScheduledTaskTrigger -Daily -At '10:00' -RandomDelay (New-TimeSpan -Hours 1)",
      '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries',
      "Register-ScheduledTask -TaskPath '\\' -TaskName 'agentcomms-update' -Description 'Installs verified agent-communications releases in the background. Its update --background-job off removes it.' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null",
      '',
    ].join('\n'),
  );
  assert.equal(
    windowsUnregisterScript(),
    [
      "$ErrorActionPreference = 'Stop'",
      "Unregister-ScheduledTask -TaskPath '\\' -TaskName 'agentcomms-update' -Confirm:$false",
      '',
    ].join('\n'),
  );
  assert.equal(
    windowsQueryScript(),
    [
      "$ErrorActionPreference = 'Stop'",
      "$task = Get-ScheduledTask -TaskPath '\\' -TaskName 'agentcomms-update' -ErrorAction SilentlyContinue",
      "if ($null -eq $task) { [Console]::Out.Write('null') } else { $first = @($task.Actions)[0]; [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ execute = [string]$first.Execute; arguments = [string]$first.Arguments })) }",
      '',
    ].join('\n'),
  );
  // A word cmd.exe or the task's own parser would read otherwise is refused, never quoted on a guess.
  for (const word of ['C:\\50%\\x', 'C:\\a"b', 'C:\\bang!', 'C:\\line\nbreak']) {
    assert.throws(() => windowsRegisterScript(['C:\\launch\\core', '--data-dir', word, 'update', '--background']), {
      name: 'CommsError',
    });
  }
});

test('Windows: the task starts the located Node with the launcher as its first argument — the exact action', () => {
  // Task Scheduler starts a program, and the launcher is a Node script with no extension: it cannot be the program.
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const launcher = 'D:\\Profiles\\Jo Example\\data\\launch\\core';
  const command = updateJobCommand({
    platform: 'win32',
    node,
    launcher,
    pins: ['--config-dir', 'D:\\Profiles\\Jo Example\\config', '--state-dir', 'D:\\state'],
  });
  assert.deepEqual(command, [
    node,
    launcher,
    '--config-dir',
    'D:\\Profiles\\Jo Example\\config',
    '--state-dir',
    'D:\\state',
    'update',
    '--background',
  ]);
  const action = windowsRegisterScript(command).split('\n')[1];
  assert.equal(
    action,
    '$action = New-ScheduledTaskAction -Execute \'C:\\Program Files\\nodejs\\node.exe\' -Argument \'"D:\\Profiles\\Jo Example\\data\\launch\\core" --config-dir "D:\\Profiles\\Jo Example\\config" --state-dir D:\\state update --background\'',
  );
  // macOS and Linux start the launcher itself: a shell script with its own #! line.
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(updateJobCommand({ platform, node, launcher: '/data/launch/core', pins: [] }), [
      '/data/launch/core',
      'update',
      '--background',
    ]);
  }
  // Left out, the Node is the one the locator names (CUE-492), as a managed registration's is.
  const m = machine();
  const located = updateJobContext(m.core, m.env, {
    platform: 'win32',
    launcher: m.launcher,
    deps: deps(recorder().run, { node: undefined }),
  });
  assert.equal(updateJobCommand(located)[0], nodeProgram(m.env, 'win32'));
  assert.equal(updateJobCommand(located)[1], m.launcher);
});

test('the job runs the stable core launcher, pinned to this installation’s four folders, with update --background', () => {
  const m = machine();
  const context = updateJobContext(m.core, m.env, {
    platform: 'darwin',
    launcher: m.launcher,
    deps: deps(recorder().run),
  });
  assert.deepEqual(updateJobCommand(context), [m.launcher, ...pins(m.core), 'update', '--background']);
  // Track B's launcher is `<data>/launch/core`: left out, that is the path taken.
  const fallback = updateJobContext(m.core, m.env, { platform: 'darwin', deps: deps(recorder().run) });
  assert.equal(updateJobCommand(fallback)[0], m.launcher);
});

// ── Installing and removing, through the runner ─────────────────────────────────────────────────────────────────

test('macOS: install writes the plist and bootstraps it into gui/<uid>; remove boots it out and deletes the file', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const context = updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
  const installed = await installUpdateJob(context);
  const plist = plistOf(m);
  assert.equal(readFileSync(plist, 'utf8'), launchAgentPlist(updateJobCommand(context), 30), 'random 0.5 is :30');
  assert.deepEqual(calls, [{ program: '/bin/launchctl', args: ['bootstrap', 'gui/501', plist] }]);
  assert.equal(installed.minute, 30);
  assert.deepEqual(JSON.parse(readFileSync(updateJobMarkerPath(m.core.paths.stateDir), 'utf8')), {
    platform: 'darwin',
    installedAt: FIXED.toISOString(),
    label: 'com.agentcomms.update',
  });
  assert.equal(await updateJobInstalled(m.core), true);

  calls.length = 0;
  const removed = await removeUpdateJob(context);
  assert.equal(removed.removed, true);
  assert.deepEqual(calls, [{ program: '/bin/launchctl', args: ['bootout', 'gui/501/com.agentcomms.update'] }]);
  assert.equal(existsSync(plist), false);
  assert.equal(existsSync(updateJobMarkerPath(m.core.paths.stateDir)), false);
  assert.equal(await updateJobInstalled(m.core), false);

  // Nothing there: removing runs nothing.
  calls.length = 0;
  assert.equal((await removeUpdateJob(context)).removed, false);
  assert.deepEqual(calls, []);
});

test('macOS: a bootstrap launchd refuses leaves no file and no record behind', async () => {
  const m = machine();
  const { run } = recorder((call) =>
    call.args[0] === 'bootstrap' ? { status: 5, stderr: 'Bootstrap failed: 5' } : {},
  );
  const context = updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
  await assert.rejects(installUpdateJob(context), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'CONFIG');
    assert.match(error.message, /Bootstrap failed: 5/);
    return true;
  });
  assert.equal(existsSync(plistOf(m)), false);
  assert.equal(await updateJobInstalled(m.core), false);
});

test('Linux: install writes both units, reloads and enables the timer; remove disables it, deletes both, reloads', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const context = updateJobContext(m.core, m.env, { platform: 'linux', launcher: m.launcher, deps: deps(run) });
  await installUpdateJob(context);
  const units = unitsOf(m);
  assert.equal(readFileSync(units.service, 'utf8'), systemdService(updateJobCommand(context)));
  assert.equal(readFileSync(units.timer, 'utf8'), systemdTimer());
  assert.deepEqual(calls, [
    { program: 'systemctl', args: ['--user', 'daemon-reload'] },
    { program: 'systemctl', args: ['--user', 'enable', '--now', 'agentcomms-update.timer'] },
  ]);
  assert.equal(
    JSON.parse(readFileSync(updateJobMarkerPath(m.core.paths.stateDir), 'utf8')).label,
    'agentcomms-update.timer',
  );

  calls.length = 0;
  assert.equal((await removeUpdateJob(context)).removed, true);
  assert.deepEqual(calls, [
    { program: 'systemctl', args: ['--user', 'disable', '--now', 'agentcomms-update.timer'] },
    { program: 'systemctl', args: ['--user', 'daemon-reload'] },
  ]);
  assert.equal(existsSync(units.service), false);
  assert.equal(existsSync(units.timer), false);
  assert.equal(await updateJobInstalled(m.core), false);
});

test('Windows: install registers the task through PowerShell; remove unregisters it — each looked up first', async () => {
  const m = machine();
  let registered = false;
  const { calls, run } = recorder((call) => {
    const script = scriptOf(call);
    if (script.includes('Get-ScheduledTask')) {
      return {
        stdout: registered ? JSON.stringify({ execute: NODE, arguments: windowsArguments(m) }) : 'null',
      };
    }
    if (script.includes('Register-ScheduledTask')) registered = true;
    if (script.includes('Unregister-ScheduledTask')) registered = false;
    return {};
  });
  const context = updateJobContext(m.core, m.env, { platform: 'win32', launcher: m.launcher, deps: deps(run) });
  await installUpdateJob(context);
  assert.deepEqual(
    calls.map(scriptOf),
    [windowsQueryScript(), windowsRegisterScript(updateJobCommand(context))],
    'looked up, then registered',
  );
  assert.equal(JSON.parse(readFileSync(updateJobMarkerPath(m.core.paths.stateDir), 'utf8')).label, 'agentcomms-update');
  assert.equal((await inspectUpdateJob(context)).state, 'installed');

  calls.length = 0;
  assert.equal((await removeUpdateJob(context)).removed, true);
  assert.deepEqual(calls.map(scriptOf), [windowsQueryScript(), windowsUnregisterScript()]);
  assert.equal(await updateJobInstalled(m.core), false);
});

/**
 * What the Windows task's `-Argument` is for this machine: the launcher, its pins and `update --background`, as the
 * writer quotes them. The task's program is the Node (`NODE`).
 */
function windowsArguments(m: Machine): string {
  const script = windowsRegisterScript([NODE, m.launcher, ...pins(m.core), 'update', '--background']);
  const found = /-Argument '((?:[^']|'')*)'/.exec(script)?.[1] ?? '';
  return found.replaceAll("''", "'");
}

// ── Setting it up: a change the person approves ─────────────────────────────────────────────────────────────────

async function connect(m: Machine, options: Partial<CoreMcpOptions> = {}) {
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

/** Core's own command, located for this machine's folders, as a darwin shell is handed it — what these tests print for. */
const inline = (m: Machine, words: readonly string[]) => coreInline(m.core.paths, words, 'darwin');

const codeOf = (result: { structuredContent?: Record<string, unknown> }) =>
  (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;

test('setting it up: the preview names the file, what it runs, when, what macOS shows and how to remove it — and nothing happens until the yes', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const { call, close } = await connect(m, { platform: 'darwin', updateJob: deps(run) });
  try {
    const first = (await call('comms_update', { backgroundJob: 'on' })).structuredContent as Record<string, unknown>;
    assert.equal(first.approvalRequired, true, JSON.stringify(first));
    assert.equal(first.summary, 'Set up the background update job on this machine');
    const preview = String(first.preview);
    assert.ok(preview.includes(plistOf(m)), 'the file');
    assert.ok(preview.includes(`${m.launcher} update --background`), 'what it runs');
    assert.match(preview, /daily at 10:00 local time and a random minute/, 'when');
    assert.match(preview, /“Background Items Added”/, 'what macOS shows');
    assert.match(preview, /Login Items/, 'where macOS lists it');
    // How to remove it, in words: the located command, with its four folders, is longer than a preview line shows.
    assert.ok(
      preview.includes(
        'to remove it, run update --background-job off with this CLI, or call comms_update with backgroundJob "off"',
      ),
      `how to remove it: ${preview}`,
    );
    for (const line of preview.split('\n')) assert.ok(line.length <= 304, `shown whole: ${line}`);
    assert.match(preview, /never sends, posts or approves anything/);
    assert.deepEqual(calls, [], 'nothing ran before the yes');
    assert.equal(existsSync(plistOf(m)), false, 'nothing written before the yes');

    const applied = (await call('comms_update', { backgroundJob: 'on', approvalId: first.approvalId }))
      .structuredContent as { applied: boolean; result: Record<string, unknown> };
    assert.equal(applied.applied, true);
    assert.equal(applied.result.backgroundJob, 'on');
    assert.equal(applied.result.changed, true);
    assert.equal(applied.result.where, plistOf(m));
    // And the result gives the command whole, located.
    assert.equal(applied.result.remove, coreCommand(m.core.paths, ['update', '--background-job', 'off'], 'darwin'));
    assert.deepEqual(calls, [{ program: '/bin/launchctl', args: ['bootstrap', 'gui/501', plistOf(m)] }]);
    assert.equal(await updateJobInstalled(m.core), true);

    // Already set up: nothing to approve, and nothing done.
    calls.length = 0;
    const again = (await call('comms_update', { backgroundJob: 'on' })).structuredContent as {
      applied: boolean;
      result: { changed: boolean };
    };
    assert.equal(again.applied, true);
    assert.equal(again.result.changed, false);
    assert.deepEqual(calls, []);

    // One at a time, as the other modes are.
    assert.equal(codeOf(await call('comms_update', { backgroundJob: 'on', pause: true })), 'USAGE');
    assert.equal(codeOf(await call('comms_update', { backgroundJob: 'on', level: 'auto' })), 'USAGE');
    assert.equal(codeOf(await call('comms_update', { backgroundJob: 'on', check: true })), 'USAGE');
    // Rollback is a mode as well: with the job, or with `noVerify`, it is refused before anything runs.
    assert.equal(codeOf(await call('comms_update', { backgroundJob: 'off', rollback: true })), 'USAGE');
    assert.equal(codeOf(await call('comms_update', { rollback: true, noVerify: true })), 'USAGE');
    assert.deepEqual(calls, []);
  } finally {
    await close();
  }
});

test('Linux and Windows previews say when each runs, and say nothing of macOS', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const m = machine();
    const { run } = recorder(() => ({ stdout: 'null' }));
    const change = updateJobChange(m.core, m.env, 'on', { platform, launcher: m.launcher, deps: deps(run) });
    const outcome = await gatedChange(m.core, change, { surface: 'mcp', channel: 'core', platform });
    assert.equal(outcome.status, 'approval-required');
    if (outcome.status !== 'approval-required') return;
    const { preview } = outcome.prepared;
    assert.doesNotMatch(preview, /macOS|Login Items/, platform);
    if (platform === 'linux') {
      assert.ok(preview.includes(unitsOf(m).service) && preview.includes(unitsOf(m).timer), preview);
      assert.match(preview, /daily, at a random moment in the hour after midnight/);
    } else {
      assert.match(preview, /the task agentcomms-update in Task Scheduler/);
      assert.match(preview, /daily at 10:00 local time, after a random delay of up to an hour/);
    }
  }
});

test('turning it off applies at once, takes no approval, and removes the job', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const context = updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
  await installUpdateJob(context);
  calls.length = 0;
  const { call, close } = await connect(m, { platform: 'darwin', updateJob: deps(run) });
  try {
    const refused = await call('comms_update', { backgroundJob: 'off', approvalId: `ap_${'0'.repeat(26)}` });
    assert.equal(codeOf(refused), 'USAGE', 'an approval is refused: nothing waits for one');
    assert.equal(existsSync(plistOf(m)), true, 'and nothing was removed by it');
    const off = (await call('comms_update', { backgroundJob: 'off' })).structuredContent as {
      applied: boolean;
      result: Record<string, unknown>;
    };
    assert.equal(off.applied, true);
    assert.equal(off.result.backgroundJob, 'off');
    assert.equal(off.result.changed, true);
    assert.deepEqual(calls, [{ program: '/bin/launchctl', args: ['bootout', 'gui/501/com.agentcomms.update'] }]);
    assert.equal(existsSync(plistOf(m)), false);
  } finally {
    await close();
  }
});

/** What `--json` prints: the result's data, or the error with its hint and details. */
interface Envelope {
  data: Record<string, unknown>;
  error: { code: string; hint: string; details: { preview: string; approvalId: string } };
}

test('the command: on waits for the approval and applies with it; off applies at once; anything else is usage', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const env = { ...m.env, CLAUDECODE: '1' };
  const cli = async (args: string[]) => {
    const written: string[] = [];
    const write = process.stdout.write;
    // What the command writes is text; the test runner's own reports, on the same stream, are bytes, and go on.
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string') {
        written.push(chunk);
        return true;
      }
      return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      const code = await main([...args, '--json'], env, 'darwin', { updateJob: deps(run) });
      return { code, out: JSON.parse(written.join('')) as Envelope };
    } finally {
      process.stdout.write = write;
    }
  };
  const pending = await cli(['update', '--background-job', 'on']);
  assert.equal(pending.code, 10);
  assert.equal(pending.out.error.code, 'APPROVAL_PENDING');
  assert.ok(String(pending.out.error.details.preview).includes(plistOf(m)));
  assert.deepEqual(calls, []);
  const approvalId = String(pending.out.error.details.approvalId);
  assert.ok(
    String(pending.out.error.hint).includes(inline(m, ['update', '--background-job', 'on', '--approval', approvalId])),
    pending.out.error.hint,
  );

  const applied = await cli(['update', '--background-job', 'on', '--approval', approvalId]);
  assert.equal(applied.code, 0, JSON.stringify(applied.out));
  assert.equal(applied.out.data.backgroundJob, 'on');
  assert.equal(existsSync(plistOf(m)), true);

  const off = await cli(['update', '--background-job', 'off']);
  assert.equal(off.code, 0, JSON.stringify(off.out));
  assert.equal(off.out.data.changed, true);
  assert.equal(existsSync(plistOf(m)), false);

  assert.equal((await cli(['update', '--background-job', 'maybe'])).code, 64);
  assert.equal((await cli(['update', '--background-job', 'on', '--pause'])).code, 64);
  assert.equal((await cli(['update', '--background-job', 'on', '--level', 'auto'])).code, 64);
  assert.equal((await cli(['update', '--background-job', 'off', '--no-verify'])).code, 64);
  assert.equal((await cli(['update', '--background-job', 'off', '--rollback'])).code, 64);
  assert.equal((await cli(['update', '--rollback', '--no-verify'])).code, 64);
});

test('setting it up is refused, before anything runs, where it would do no good or harm', async () => {
  const cases: [string, (m: Machine) => void, RegExp][] = [
    ['the stable launcher is not there yet', (m) => rmSync(m.launcher), /launcher/],
    [
      'a job another installation wrote is there',
      (m) => {
        mkdirSync(dirname(plistOf(m)), { recursive: true });
        writeFileSync(plistOf(m), launchAgentPlist(['/opt/elsewhere/launch/core', 'update', '--background'], 3));
      },
      /did not write/,
    ],
  ];
  for (const [label, arrange, pattern] of cases) {
    const m = machine();
    arrange(m);
    const { calls, run } = recorder();
    const change = updateJobChange(m.core, m.env, 'on', { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
    await assert.rejects(gatedChange(m.core, change, { surface: 'mcp', channel: 'core' }), (error: unknown) => {
      assert.ok(error instanceof CommsError, label);
      assert.equal(error.code, 'CONFIG', label);
      assert.match(error.message, pattern, label);
      return true;
    });
    assert.deepEqual(calls, [], label);
  }
});

// ── An organisation profile with `updates.background: false` (U8) ─────────────────────────────────────────────────

test('a profile that turns background updates off refuses the setup, and nothing runs or is written', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const change = updateJobChange(m.core, m.env, 'on', {
    platform: 'darwin',
    launcher: m.launcher,
    background: false,
    deps: deps(run),
  });
  await assert.rejects(gatedChange(m.core, change, { surface: 'cli', channel: 'core' }), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'CONFIG');
    assert.match(error.message, /organisation profile/);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(existsSync(plistOf(m)), false);
  assert.equal((await m.core.approvals.list()).length, 0, 'no approval was prepared');
});

test('a profile that arrives after the job is set up: the next run removes the job and leaves a notice (Review focus 5)', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const context = updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
  await installUpdateJob(context);
  // Allowed: the run carries on, and nothing is touched.
  calls.length = 0;
  assert.deepEqual(await backgroundJobAtRun(context, { background: true }), { removed: false, notice: null });
  assert.deepEqual(calls, []);
  assert.equal(existsSync(plistOf(m)), true);

  const stopped = await backgroundJobAtRun(context, { background: false });
  assert.equal(stopped.removed, true);
  assert.match(String(stopped.notice), /organisation profile/);
  assert.match(String(stopped.notice), /background update job was removed/);
  assert.deepEqual(calls, [{ program: '/bin/launchctl', args: ['bootout', 'gui/501/com.agentcomms.update'] }]);
  assert.equal(existsSync(plistOf(m)), false);
  assert.equal(await updateJobInstalled(m.core), false);
  const audit = await m.core.audit.tail({ limit: 5 });
  assert.ok(
    audit.some(
      (record) => record.operation === 'update.job.removed' && /organisation profile/.test(record.reason ?? ''),
    ),
    JSON.stringify(audit),
  );
});

// ── Removal on a level change ───────────────────────────────────────────────────────────────────────────────────

test('a level that installs nothing in the background removes the job: its preview says so, and its yes does it', async () => {
  const m = machine();
  const { calls, run } = recorder();
  const context = updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
  await installUpdateJob(context);
  calls.length = 0;
  const { call, close } = await connect(m, { platform: 'darwin', updateJob: deps(run) });
  try {
    // At the level `never` nothing installs in the background (design 2026-10-16 U2, U4).
    const off = (await call('comms_update', { level: 'never' })).structuredContent as Record<string, unknown>;
    assert.equal(off.approvalRequired, true);
    assert.ok(String(off.preview).includes(`removes the background update job, ${plistOf(m)}`), String(off.preview));
    assert.deepEqual(calls, [], 'nothing before the yes');
    assert.equal(existsSync(plistOf(m)), true);
    const turned = (await call('comms_update', { level: 'never', approvalId: off.approvalId })).structuredContent as {
      applied: boolean;
    };
    assert.equal(turned.applied, true);
    assert.deepEqual(calls, [{ program: '/bin/launchctl', args: ['bootout', 'gui/501/com.agentcomms.update'] }]);
    assert.equal(existsSync(plistOf(m)), false);
    assert.equal(await updateJobInstalled(m.core), false);
    // And at that level it cannot be set up again.
    assert.equal(codeOf(await call('comms_update', { backgroundJob: 'on' })), 'CONFIG');
  } finally {
    await close();
  }
  // With no job, the level change says nothing of one.
  const fresh = machine();
  const request = await updateLevelChange(fresh.core, 'never', {
    env: fresh.env,
    platform: 'darwin',
    job: deps(recorder().run),
  }).plan(await fresh.core.config.load());
  assert.deepEqual(request.effects ?? [], []);
});

// ── The doctor ──────────────────────────────────────────────────────────────────────────────────────────────────

async function jobRow(m: Machine, platform: NodeJS.Platform, run: UpdateJobRunner, background?: boolean) {
  const report = await doctor(m.core, m.env, {
    platform,
    keyring: null,
    updateJob: deps(run),
    // The job was set up at FIXED: the doctor reads whether it has run since on the same clock.
    now: () => FIXED,
    ...(background === undefined ? {} : { background }),
  });
  return report.checks.filter((check) => check.name === 'background update job');
}

test('the doctor: nothing when there is no job; installed, missing, foreign and stale, each with its fix', async () => {
  const m = machine();
  const { calls, run } = recorder();
  assert.deepEqual(await jobRow(m, 'darwin', run), [], 'no job, no row: every other doctor reads as it did');

  const context = updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
  await installUpdateJob(context);
  calls.length = 0;
  const [installed] = await jobRow(m, 'darwin', run);
  assert.equal(installed?.ok, true);
  assert.equal(installed?.warn, undefined);
  assert.match(String(installed?.detail), /^installed: /);
  assert.ok(String(installed?.detail).includes(plistOf(m)));

  // Stale: what this release writes has changed — here, the launcher it runs has gone.
  rmSync(m.launcher);
  const [stale] = await jobRow(m, 'darwin', run);
  assert.equal(stale?.warn, true);
  assert.match(String(stale?.detail), /^stale: /);
  assert.ok(String(stale?.fix).includes(inline(m, ['update', '--background-job', 'on'])), stale?.fix);
  writeFileSync(m.launcher, '#!/bin/sh\n');

  // Missing: set up, and the file gone.
  rmSync(plistOf(m));
  const [missing] = await jobRow(m, 'darwin', run);
  assert.equal(missing?.warn, true);
  assert.match(String(missing?.detail), /^missing: /);
  assert.ok(String(missing?.fix).includes(inline(m, ['update', '--background-job', 'on'])));
  assert.ok(String(missing?.fix).includes(inline(m, ['update', '--background-job', 'off'])));

  // Foreign: a job at that place this installation did not write.
  rmSync(updateJobMarkerPath(m.core.paths.stateDir));
  writeFileSync(plistOf(m), launchAgentPlist(['/opt/elsewhere/launch/core', 'update', '--background'], 3));
  const [foreign] = await jobRow(m, 'darwin', run);
  assert.equal(foreign?.warn, true);
  assert.match(String(foreign?.detail), /^foreign: /);
  assert.ok(String(foreign?.detail).includes('/opt/elsewhere/launch/core'));
  assert.match(String(foreign?.fix), /leaves it alone/);
  assert.deepEqual(calls, [], 'the doctor runs nothing on macOS');
});

test('the doctor on Linux reads the units; on Windows it asks the scheduler only when a job is recorded', async () => {
  const linux = machine();
  const { run } = recorder();
  const context = updateJobContext(linux.core, linux.env, {
    platform: 'linux',
    launcher: linux.launcher,
    deps: deps(run),
  });
  await installUpdateJob(context);
  assert.match(String((await jobRow(linux, 'linux', run))[0]?.detail), /^installed: /);
  rmSync(unitsOf(linux).timer);
  assert.match(String((await jobRow(linux, 'linux', run))[0]?.detail), /^stale: /);
  rmSync(unitsOf(linux).service);
  assert.match(String((await jobRow(linux, 'linux', run))[0]?.detail), /^missing: /);

  const windows = machine();
  const asked = recorder(() => ({ stdout: 'null' }));
  assert.deepEqual(await jobRow(windows, 'win32', asked.run), []);
  assert.deepEqual(asked.calls, [], 'nothing recorded: the scheduler is not asked');
  mkdirSync(windows.core.paths.stateDir, { recursive: true });
  writeFileSync(
    updateJobMarkerPath(windows.core.paths.stateDir),
    `${JSON.stringify({ platform: 'win32', installedAt: FIXED.toISOString(), label: 'agentcomms-update' })}\n`,
  );
  assert.match(String((await jobRow(windows, 'win32', asked.run))[0]?.detail), /^missing: /);
  assert.deepEqual(asked.calls.map(scriptOf), [windowsQueryScript()]);
  const there = recorder(() => ({
    stdout: JSON.stringify({ execute: NODE, arguments: windowsArguments(windows) }),
  }));
  assert.match(String((await jobRow(windows, 'win32', there.run))[0]?.detail), /^installed: /);
  // 0.20.0's task, which named the launcher as its program: this installation's, and not what this release writes.
  const legacy = recorder(() => ({
    stdout: JSON.stringify({
      execute: windows.launcher,
      arguments: windowsArguments(windows).slice(windowsArguments(windows).indexOf(' --config-dir') + 1),
    }),
  }));
  assert.match(String((await jobRow(windows, 'win32', legacy.run))[0]?.detail), /^stale: /);
});

test('the doctor names a profile that turns background updates off, while the job is still there', async () => {
  const m = machine();
  const { run } = recorder();
  await installUpdateJob(
    updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) }),
  );
  const [row] = await jobRow(m, 'darwin', run, false);
  assert.equal(row?.warn, true);
  assert.match(String(row?.detail), /organisation profile/);
  assert.ok(String(row?.fix).includes(inline(m, ['update', '--background-job', 'off'])));
});

// ── Track A's settings, read for real (design 2026-10-16 U2, U8) ──────────────────────────────────────────────────

/** The machine's configuration, rewritten: `defaults`, and an organisation record whose profile caps updates. */
function configure(m: Machine, defaults: Record<string, unknown>, caps?: { max?: string; background?: boolean }) {
  const organisations =
    caps === undefined
      ? {}
      : {
          organisations: {
            acme: {
              label: 'Acme Test Org',
              source: { kind: 'file', path: join(m.home, 'profiles', 'acme.agentcomms.json') },
              sha256: 'a'.repeat(64),
              readAt: FIXED.toISOString(),
              addedAt: FIXED.toISOString(),
              forOtherAddresses: false,
              updates: { ...caps, sha256: 'b'.repeat(64) },
            },
          },
        };
  writeFileSync(
    join(m.core.paths.configDir, 'config.json'),
    `${JSON.stringify({ version: 2, secrets: { store: 'file' }, defaults, ...organisations })}\n`,
  );
}

test('setting the job up reads the level in force: the level set, an organisation’s cap and its background: false', async () => {
  const cases: [string, (m: Machine) => void, RegExp][] = [
    // 0.18's switch is still on beside the level: the level is what counts.
    [
      'every-14-days set',
      (m) => configure(m, { updates: 'every-14-days', updateCheck: 'on' }),
      /at the level every-14-days nothing installs in the background/,
    ],
    [
      'a cap at every-14-days',
      (m) => configure(m, { updates: 'auto' }, { max: 'every-14-days' }),
      /acme’s profile caps updates at every-14-days/,
    ],
    ['background: false', (m) => configure(m, {}, { background: false }), /organisation profile/],
  ];
  for (const [label, arrange, pattern] of cases) {
    const m = machine();
    arrange(m);
    const { calls, run } = recorder();
    const change = updateJobChange(m.core, m.env, 'on', { platform: 'darwin', launcher: m.launcher, deps: deps(run) });
    await assert.rejects(gatedChange(m.core, change, { surface: 'mcp', channel: 'core' }), (error: unknown) => {
      assert.ok(error instanceof CommsError, label);
      assert.equal(error.code, 'CONFIG', label);
      assert.match(error.message, pattern, `${label}: ${error.message}`);
      return true;
    });
    assert.deepEqual(calls, [], label);
    assert.equal(existsSync(plistOf(m)), false, label);
  }
  // auto, uncapped: it is offered, and approved first.
  const m = machine();
  configure(m, { updates: 'auto' });
  const { run } = recorder();
  const outcome = await gatedChange(
    m.core,
    updateJobChange(m.core, m.env, 'on', { platform: 'darwin', launcher: m.launcher, deps: deps(run) }),
    { surface: 'mcp', channel: 'core' },
  );
  assert.equal(outcome.status, 'approval-required');
});

test('the doctor reads an organisation’s background: false from the configuration, with no option handed in', async () => {
  const m = machine();
  const { run } = recorder();
  await installUpdateJob(
    updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) }),
  );
  configure(m, {}, { background: false });
  const [row] = await jobRow(m, 'darwin', run);
  assert.equal(row?.warn, true);
  assert.match(String(row?.detail), /organisation profile turns background updates off/);
});

/** The command as an agent's shell runs it, `--json`, capturing what it writes: as the test above does. */
async function commandAt(m: Machine, run: UpdateJobRunner, args: string[]) {
  const written: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === 'string') {
      written.push(chunk);
      return true;
    }
    return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    const code = await main([...args, '--json'], { ...m.env, CLAUDECODE: '1' }, 'darwin', { updateJob: deps(run) });
    return { code, out: JSON.parse(written.join('')) as Envelope };
  } finally {
    process.stdout.write = write;
  }
}

test('every-14-days and never each remove the job, from the CLI and from comms_update; auto leaves it', async () => {
  for (const [level, surface] of [
    ['every-14-days', 'cli'],
    ['never', 'cli'],
    ['every-14-days', 'mcp'],
  ] as const) {
    const label = `${level} (${surface})`;
    const m = machine();
    const { calls, run } = recorder();
    await installUpdateJob(
      updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) }),
    );
    calls.length = 0;
    if (surface === 'cli') {
      const pending = await commandAt(m, run, ['update', '--level', level]);
      assert.equal(pending.code, 10, `${label}: a level that updates less is approved first`);
      assert.ok(
        pending.out.error.details.preview.includes(`removes the background update job, ${plistOf(m)}`),
        `${label}: ${pending.out.error.details.preview}`,
      );
      assert.equal(existsSync(plistOf(m)), true, `${label}: nothing before the yes`);
      const applied = await commandAt(m, run, [
        'update',
        '--level',
        level,
        '--approval',
        pending.out.error.details.approvalId,
      ]);
      assert.equal(applied.code, 0, `${label}: ${JSON.stringify(applied.out)}`);
    } else {
      const { call, close } = await connect(m, { platform: 'darwin', updateJob: deps(run) });
      try {
        const first = (await call('comms_update', { level })).structuredContent as Record<string, unknown>;
        assert.equal(first.approvalRequired, true, label);
        assert.ok(String(first.preview).includes(`removes the background update job, ${plistOf(m)}`), label);
        const done = (await call('comms_update', { level, approvalId: first.approvalId })).structuredContent;
        assert.equal((done as { applied?: boolean }).applied, true, label);
      } finally {
        await close();
      }
    }
    assert.deepEqual(calls, [{ program: '/bin/launchctl', args: ['bootout', 'gui/501/com.agentcomms.update'] }], label);
    assert.equal(existsSync(plistOf(m)), false, label);
    assert.equal(await updateJobInstalled(m.core), false, label);
  }
  // Moving back to auto applies at once and leaves a job alone.
  const m = machine();
  const { calls, run } = recorder();
  await installUpdateJob(
    updateJobContext(m.core, m.env, { platform: 'darwin', launcher: m.launcher, deps: deps(run) }),
  );
  calls.length = 0;
  const { call, close } = await connect(m, { platform: 'darwin', updateJob: deps(run) });
  try {
    const back = (await call('comms_update', { level: 'auto' })).structuredContent as Record<string, unknown>;
    assert.equal(back.applied, true, JSON.stringify(back));
    assert.deepEqual(calls, []);
    assert.equal(existsSync(plistOf(m)), true);
  } finally {
    await close();
  }
});
