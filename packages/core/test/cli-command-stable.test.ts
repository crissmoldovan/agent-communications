import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gatedChange } from '../src/change-flow.ts';
import {
  type CliCommandRequest,
  type CliCommandResult,
  locateCliCommand,
  type NodeRuntime,
  type PrintedCommand,
} from '../src/cli-command.ts';
import { openCore } from '../src/core.ts';
import { handoffText, isCommand } from '../src/handoffs.ts';
import { launcherPaths, switchPointer, writeLauncher } from '../src/launcher.ts';
import { managedShimPath, writeManagedShim } from '../src/managed-shims.ts';
import { updateJobChange } from '../src/operations/update-job.ts';
import type { PathName, ResolvedPaths } from '../src/paths.ts';
import { moduleUrl, realTemp, suiteEntry, VERSION, writeManaged, writePackage } from './fixtures/cli-command/trees.ts';

/*
 * A command printed from a managed runtime names this installation's stable way in, not the runtime (0.21): the
 * background job prunes old runtimes, so `<data>/runtime/0.20.0-core/…/cli.mjs` in a command printed today is gone two
 * releases later. With the stable launcher `<data>/launch/<name>` there, starting this same release, the command names
 * it; with none, a managed CLI shim of this installation that starts this very entry; with neither, the runtime's entry,
 * as before. Nothing here runs a command, and every tree is under a temporary directory.
 */

const NODE: NodeRuntime = { version: 'v22.18.0', execArgv: [] };
/** The Node a POSIX launcher written here would start: a full POSIX path on every platform, never run. */
const LAUNCHER_NODE = '/usr/bin/node';
const FOUR: readonly PathName[] = ['configDir', 'stateDir', 'dataDir', 'secretsDir'];
const WORDS = ['update', '--background-job', 'off'];

function installation(): { temp: string; paths: ResolvedPaths; pins: string[] } {
  const temp = realTemp('cli-stable-');
  const paths: ResolvedPaths = {
    configDir: join(temp, 'config'),
    stateDir: join(temp, 'state'),
    dataDir: join(temp, 'data'),
    secretsDir: join(temp, 'secrets'),
    downloadsDir: join(temp, 'downloads'),
  };
  const pins = [
    '--config-dir',
    paths.configDir,
    '--state-dir',
    paths.stateDir,
    '--data-dir',
    paths.dataDir,
    '--secrets-dir',
    paths.secretsDir,
  ];
  return { temp, paths, pins };
}

function request(
  paths: ResolvedPaths,
  callerRoot: string,
  callerChannel: string,
  targetChannel: string,
  overrides: Partial<CliCommandRequest> = {},
): CliCommandRequest {
  return {
    caller: { url: moduleUrl(callerRoot, 'dist', 'cli.mjs'), packageName: suiteEntry(callerChannel).packageName },
    target: suiteEntry(targetChannel),
    words: WORDS,
    uses: FOUR,
    paths,
    platform: 'linux',
    // A home under the test's own folder: a managed shim is never looked for in the person's ~/.local/bin.
    env: { HOME: join(paths.dataDir, '..', 'home') },
    ...overrides,
  };
}

function located(result: CliCommandResult): PrintedCommand {
  assert.equal(result.ok, true, result.ok ? '' : `not located: ${result.reason}: ${result.message}`);
  if (!result.ok) throw new Error('unreachable');
  return result.command;
}

/** The runtime folder a managed package root is in: `<data>/runtime/<version>-<name>`. */
const runtimeOf = (root: string) => join(root, '..', '..', '..');

test("from a managed runtime, a command names the installation's stable launcher, not the versioned runtime", async () => {
  const { paths, pins } = installation();
  const core = writeManaged(paths.dataDir, 'core');
  // No launcher yet: the runtime's own entry, as before.
  const before = located(locateCliCommand(request(paths, core.root, 'core', 'core'), NODE));
  assert.deepEqual(before.words, [process.execPath, core.entry, ...pins, ...WORDS]);

  await writeLauncher(paths.dataDir, 'core', LAUNCHER_NODE, { platform: 'linux' });
  await switchPointer(paths.dataDir, 'core', runtimeOf(core.root));
  const { launcher } = launcherPaths(paths.dataDir, 'core');
  for (const platform of ['linux', 'darwin'] as const) {
    const result = locateCliCommand(request(paths, core.root, 'core', 'core', { platform }), NODE);
    const command = located(result);
    assert.deepEqual(command.words, [launcher, ...pins, ...WORDS], platform);
    assert.equal(command.entry, launcher);
    assert.ok(result.ok && result.basis.entryKind === 'launcher');
    assert.doesNotMatch(command.line ?? '', /[\\/]runtime[\\/]/, 'no versioned runtime in the command');
  }
  // On Windows the launcher is a script Node runs: this Node, then the launcher, as a registration starts it.
  const windows = located(locateCliCommand(request(paths, core.root, 'core', 'core', { platform: 'win32' }), NODE));
  assert.deepEqual(windows.words, [process.execPath, launcher, ...pins, ...WORDS]);
});

test('a launcher that starts another release, or none, is not named: the command names the runtime, as before', async () => {
  const { paths, pins } = installation();
  const core = writeManaged(paths.dataDir, 'core');
  const older = writeManaged(paths.dataDir, 'core', { version: '0.0.1' });
  await writeLauncher(paths.dataDir, 'core', LAUNCHER_NODE, { platform: 'linux' });
  // The pointer names 0.0.1: the launcher would run another release than the one printing.
  await switchPointer(paths.dataDir, 'core', runtimeOf(older.root));
  assert.deepEqual(located(locateCliCommand(request(paths, core.root, 'core', 'core'), NODE)).words, [
    process.execPath,
    core.entry,
    ...pins,
    ...WORDS,
  ]);
  // A launcher with no pointer starts nothing.
  const bare = installation();
  const alone = writeManaged(bare.paths.dataDir, 'core');
  await writeLauncher(bare.paths.dataDir, 'core', LAUNCHER_NODE, { platform: 'linux' });
  assert.deepEqual(located(locateCliCommand(request(bare.paths, alone.root, 'core', 'core'), NODE)).words, [
    process.execPath,
    alone.entry,
    ...bare.pins,
    ...WORDS,
  ]);
});

test("a runtime outside this installation's data folder is named as before, whatever launcher the folder has", async () => {
  const { temp, paths, pins } = installation();
  const ours = writeManaged(paths.dataDir, 'core');
  await writeLauncher(paths.dataDir, 'core', LAUNCHER_NODE, { platform: 'linux' });
  await switchPointer(paths.dataDir, 'core', runtimeOf(ours.root));
  // The same release, installed under another data folder than the one this command pins.
  const elsewhere = writeManaged(join(temp, 'other-data'), 'core');
  assert.deepEqual(located(locateCliCommand(request(paths, elsewhere.root, 'core', 'core'), NODE)).words, [
    process.execPath,
    elsewhere.entry,
    ...pins,
    ...WORDS,
  ]);
});

test("a channel's command for core names core's stable launcher when it starts this same release", async () => {
  const { paths, pins } = installation();
  const gmail = writeManaged(paths.dataDir, 'gmail');
  // Core as the Gmail runtime carries it: its installed dependency.
  const carried = join(runtimeOf(gmail.root), 'node_modules', '@agentcomms', 'core');
  writePackage(carried, 'core', { files: ['dist/cli.mjs'] });
  const before = located(locateCliCommand(request(paths, gmail.root, 'gmail', 'core'), NODE));
  assert.deepEqual(before.words, [process.execPath, join(carried, 'dist', 'cli.mjs'), ...pins, ...WORDS]);

  const core = writeManaged(paths.dataDir, 'core');
  await writeLauncher(paths.dataDir, 'core', LAUNCHER_NODE, { platform: 'linux' });
  await switchPointer(paths.dataDir, 'core', runtimeOf(core.root));
  const { launcher } = launcherPaths(paths.dataDir, 'core');
  const result = locateCliCommand(request(paths, gmail.root, 'gmail', 'core'), NODE);
  assert.deepEqual(located(result).words, [launcher, ...pins, ...WORDS]);
  assert.ok(result.ok && result.basis.direction === 'channel-to-core');
});

const POSIX =
  process.platform === 'win32' ? { skip: 'WINDOWS_SKIP: managed CLI shims are offered on macOS and Linux only' } : {};

test(
  'with no launcher, a managed shim of this installation that starts this very entry is named instead',
  POSIX,
  async () => {
    const { temp, paths, pins } = installation();
    const core = writeManaged(paths.dataDir, 'core');
    const env = { HOME: temp, PATH: '' };
    const context = { env, dataDir: paths.dataDir, platform: 'linux' as const };
    const binary = suiteEntry('core').manifest.binary;
    // As a release before the stable launcher wrote it: the locator's command for the runtime's entry.
    await writeManagedShim(context, { binary, command: [process.execPath, core.entry], entry: core.entry });
    const shim = managedShimPath(context, binary);
    const result = locateCliCommand(request(paths, core.root, 'core', 'core', { env }), NODE);
    assert.deepEqual(located(result).words, [shim, ...pins, ...WORDS]);
    assert.ok(result.ok && result.basis.entryKind === 'shim');

    // A shim changed since it was written is not this installation's to name.
    writeFileSync(shim, '#!/bin/sh\nexec something-else "$@"\n');
    assert.deepEqual(located(locateCliCommand(request(paths, core.root, 'core', 'core', { env }), NODE)).words, [
      process.execPath,
      core.entry,
      ...pins,
      ...WORDS,
    ]);
  },
);

test('the background job’s “To remove it” command, set up from a managed runtime, names the stable launcher', async () => {
  const { temp, paths } = installation();
  const env = {
    HOME: temp,
    USERPROFILE: temp,
    PATH: join(temp, 'bin'),
    AGENT_COMMS_CONFIG_DIR: paths.configDir,
    AGENT_COMMS_STATE_DIR: paths.stateDir,
    AGENT_COMMS_DATA_DIR: paths.dataDir,
    AGENT_COMMS_SECRETS_DIR: paths.secretsDir,
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
    NO_COLOR: '1',
  };
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(
    join(paths.configDir, 'config.json'),
    `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`,
  );
  const runtime = writeManaged(paths.dataDir, 'core');
  await writeLauncher(paths.dataDir, 'core', LAUNCHER_NODE, { platform: 'darwin' });
  await switchPointer(paths.dataDir, 'core', runtimeOf(runtime.root));
  const { launcher } = launcherPaths(paths.dataDir, 'core');
  // Core as it runs from that runtime: its caller is the runtime's own CLI module.
  const core = openCore({
    env,
    caller: { url: moduleUrl(runtime.root, 'dist', 'cli.mjs'), packageName: suiteEntry('core').packageName },
  });
  const run = async () => ({ status: 0, stdout: '', stderr: '' });
  const options = {
    platform: 'darwin' as const,
    launcher,
    deps: { run, uid: 501, random: () => 0.5, now: () => new Date('2026-10-18T09:00:00.000Z') },
  };
  const first = await gatedChange(core, updateJobChange(core, env, 'on', options), {
    surface: 'mcp',
    channel: 'core',
    platform: 'darwin',
  });
  assert.equal(first.status, 'approval-required');
  if (first.status !== 'approval-required') return;
  const second = await gatedChange(core, updateJobChange(core, env, 'on', options), {
    surface: 'mcp',
    channel: 'core',
    platform: 'darwin',
    approvalId: first.prepared.approvalId,
  });
  assert.equal(second.status, 'applied');
  if (second.status !== 'applied') return;
  const remove = String(second.result.remove);
  // The command the job was set up for, quoted for its platform: the launcher, then the folders and the words.
  const off = core.handoffs?.on('darwin').core(['update', '--background-job', 'off']);
  assert.ok(off !== undefined && isCommand(off), 'core locates its own command');
  assert.equal(off.words[0], launcher);
  assert.equal(remove, handoffText(off));
  assert.ok(remove.endsWith(' update --background-job off'), remove);
  assert.doesNotMatch(remove, new RegExp(`runtime[\\\\/]${VERSION.replaceAll('.', '\\.')}-core`));
});
