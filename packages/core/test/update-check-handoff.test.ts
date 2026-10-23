import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CliCommandCaller } from '../src/cli-command.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { launcherPaths, switchPointer, writeLauncher } from '../src/launcher.ts';
import { PATH_OPTIONS } from '../src/paths.ts';
import {
  checkForUpdates,
  coreUpdateCheckWords,
  startCheckChild,
  terminalUpdateHooks,
  UPDATE_CHECK_CHILD_COMMAND,
  type UpdateCheckChildEntry,
  updateCheckChildEnvironment,
} from '../src/update-check.ts';
import { TERMINAL_CHECK_WAIT_MS } from '../src/update-gate.ts';
import {
  changeUpdateCheck,
  readUpdateCheck,
  UPDATE_CHECK_LEASE_MS,
  type UpdateCheckRecord,
} from '../src/update-state.ts';
import { moduleUrl, realTemp, writeManaged, writePackage } from './fixtures/cli-command/trees.ts';
import { holdLock } from './helpers/hold-lock.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * A channel's update check, handed to core's CLI (design 2026-10-22, P2). A channel bundles core's code but not its
 * Sigstore verifier, so its own check can read nothing a release declares. When core is installed beside it at the
 * channel's own version, the channel's command and its server claim the day's check and start core's CLI with the
 * hidden `update-check-child <claimedAt>`, which verifies; with no such core, or a start that fails, the channel checks
 * as it always did.
 *
 * Nothing here reaches npm: every `start` is a recorder or a program that cannot start, but one, which starts core's
 * own CLI against a registry port nobody answers on. Nothing here reaches Sigstore: that ask ends at the registry.
 */

/** Core's CLI in this checkout: what a channel from source locates as core's, through its own dependency on it. */
const CORE_CLI = realpathSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));
/** A module of Gmail's own package in this checkout: a channel opening core, as its command and server do. */
const GMAIL_CALLER: CliCommandCaller = Object.freeze({
  url: new URL('../../gmail/src/caller.ts', import.meta.url).href,
  packageName: '@agentcomms/gmail',
});
/** The channel's own CLI, as `updateCheckChildEntry` would find it: never started here, only recorded. */
const OWN: UpdateCheckChildEntry = Object.freeze({
  command: process.execPath,
  args: Object.freeze([join(tempDir('comms-update-handoff-own-'), 'dist', 'cli.mjs')]),
});
const RELEASE = Object.freeze({ version: '99.0.0', security: true, needsDecision: false });

interface Machine {
  env: Record<string, string>;
  core: Core;
  stateDir: string;
}

/** A home of its own with the check on, and core opened as `caller` opens it — or with no caller at all. */
function machine(caller: CliCommandCaller | 'none' = GMAIL_CALLER, extra: Record<string, string> = {}): Machine {
  const home = tempDir('comms-update-handoff-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    NO_COLOR: '1',
    npm_config_offline: 'true',
    // Nobody answers here: an ask that got past a stand-in fails at once instead of reaching the real registry.
    npm_config_registry: 'http://127.0.0.1:9/',
    ...extra,
  };
  const core = caller === 'none' ? openCore({ env }) : openCore({ env, caller });
  return { env, core, stateDir: core.paths.stateDir };
}

/** The file a day and more old, holding a verified release a check found then: the next process claims the check. */
async function due(m: Machine): Promise<void> {
  mkdirSync(m.stateDir, { recursive: true });
  await changeUpdateCheck(m.stateDir, () => ({
    record: {
      lastChecked: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      latest: RELEASE.version,
      behind: true,
      release: { ...RELEASE },
    } as UpdateCheckRecord,
  }));
}

interface Started {
  words: string[];
  env: NodeJS.ProcessEnv;
  deadline: number;
  at: number;
}

/** A `start` that starts nothing: it records each call and answers `answer(words, n)`, true by default. */
function recorder(answer: (words: readonly string[], call: number) => boolean | Promise<boolean> = () => true) {
  const calls: Started[] = [];
  const start = async (words: readonly string[], env: NodeJS.ProcessEnv, deadline: number) => {
    calls.push({ words: [...words], env, deadline, at: Date.now() });
    return answer(words, calls.length);
  };
  return { calls, start };
}

/** The channel's own child, as it is started today: its CLI again, every folder pinned, then the hidden command. */
function ownWords(m: Machine, claimedAt: string): string[] {
  const pins = PATH_OPTIONS.flatMap(({ key, flag }) => [flag, m.core.paths[key]]);
  return [OWN.command, ...OWN.args, ...pins, UPDATE_CHECK_CHILD_COMMAND, claimedAt];
}

/** Whether `words` start core's CLI here — this Node, core's source entry — with every folder pinned before the words. */
function assertCoreWords(m: Machine, words: readonly string[], claimedAt: string): void {
  assert.deepEqual(words.slice(-2), [UPDATE_CHECK_CHILD_COMMAND, claimedAt], JSON.stringify(words));
  assert.equal(realpathSync(words[0] as string), realpathSync(process.execPath), 'the program is not this Node');
  const entry = words.indexOf(CORE_CLI);
  assert.ok(entry > 0, `core's own CLI is not the entry: ${JSON.stringify(words)}`);
  for (const { key, flag } of PATH_OPTIONS) {
    const at = words.indexOf(flag);
    assert.ok(at > entry, `${flag} is not pinned after the entry: ${JSON.stringify(words)}`);
    assert.equal(words[at + 1], m.core.paths[key], flag);
  }
}

test("a channel's command hands the day's check to core's located CLI, under its claim", async () => {
  const m = machine();
  await due(m);
  const handed = recorder();
  await terminalUpdateHooks(m.core, m.env, { handOff: { start: handed.start }, childEntry: OWN }).check?.();
  assert.equal(handed.calls.length, 1, JSON.stringify(handed.calls.map(({ words }) => words)));
  const record = await readUpdateCheck(m.stateDir);
  // Claimed by the command, and handed on: the claim is core's child's to ask under, so nothing is settled here.
  assert.equal(typeof record.checking, 'string');
  assertCoreWords(m, (handed.calls[0] as Started).words, record.checking as string);
  // The notice's three seconds: the command waits no longer for core's child than it did for its own.
  const { deadline, at } = handed.calls[0] as Started;
  assert.ok(deadline - at <= TERMINAL_CHECK_WAIT_MS, `the command waits ${deadline - at} ms`);
  assert.deepEqual(record.release, RELEASE, 'the verified release was touched');
});

test("the server's check is handed on too, and waits no longer than the lease", async () => {
  const m = machine();
  await due(m);
  const handed = recorder();
  const outcome = await checkForUpdates(m.core, m.env, { handOff: { start: handed.start } });
  assert.equal(handed.calls.length, 1);
  const record = await readUpdateCheck(m.stateDir);
  assertCoreWords(m, (handed.calls[0] as Started).words, record.checking as string);
  const { deadline, at } = handed.calls[0] as Started;
  // As long as the claim holds, and no longer: past it, another process may claim the check and ask.
  assert.ok(deadline - at <= UPDATE_CHECK_LEASE_MS, `the server waits ${deadline - at} ms`);
  assert.ok(deadline - at > UPDATE_CHECK_LEASE_MS - 10_000, `the server waits only ${deadline - at} ms`);
  assert.equal(outcome.asked, true);
  // A check that is not due, or claimed by another process, hands nothing on.
  const again = recorder();
  assert.equal((await checkForUpdates(m.core, m.env, { handOff: { start: again.start } })).asked, false);
  assert.equal(again.calls.length, 0);
});

test('a claim waits 2 s at most for a lock handed on, so the command can end while the lock still changes hands', async () => {
  /*
   * 0.26.0 review B, finding 1. Holders of 1 s each, back to back, as a busy machine's refreshes hand the lock on.
   * Waited out holder by holder, as a record that matters waits (`UPDATE_CHECK_LOCK`), the claim kept the command's
   * process, and its stdout, for up to 15 s after the command had finished, and a `$(…)`, a pipe or an agent's shell
   * waited with it. A claim is best effort, as a notice is: busy past 2 s, nothing is claimed, and a later process
   * claims the day's check.
   */
  const m = machine();
  await due(m);
  const held = holdLock(
    join(m.stateDir, '.update-check.lock'),
    Array.from({ length: 8 }, () => 1_000),
  );
  await held.taken;
  let over = false;
  void held.then(() => {
    over = true;
  });
  const handed = recorder();
  const started = Date.now();
  await terminalUpdateHooks(m.core, m.env, { handOff: { start: handed.start }, childEntry: OWN }).check?.();
  const waited = Date.now() - started;
  assert.equal(over, false, `the command's check waited ${waited} ms, until the lock was free`);
  assert.ok(waited < 4_000, `the command's check waited ${waited} ms`);
  // A server's check claims the same way: it goes on, and a later call claims.
  const outcome = await checkForUpdates(m.core, m.env, { handOff: { start: handed.start } });
  assert.equal(over, false, "the server's check waited until the lock was free");
  assert.equal(outcome.asked, false);
  assert.deepEqual(handed.calls, [], 'a check was started with no claim');
  await held;
  assert.equal((await readUpdateCheck(m.stateDir)).checking, null, 'nothing was claimed while the lock was busy');
  // Once the lock is free, the next process claims the check, and hands it on.
  const later = recorder();
  await terminalUpdateHooks(m.core, m.env, { handOff: { start: later.start }, childEntry: OWN }).check?.();
  assert.equal(later.calls.length, 1);
  assertCoreWords(m, (later.calls[0] as Started).words, (await readUpdateCheck(m.stateDir)).checking as string);
});

test('with no core located, the channel checks as before', async () => {
  // The command: its own child, with the words it always had; nothing it found is touched.
  const m = machine();
  await due(m);
  const handed = recorder();
  await terminalUpdateHooks(m.core, m.env, {
    handOff: { locate: () => null, start: handed.start },
    childEntry: OWN,
  }).check?.();
  const record = await readUpdateCheck(m.stateDir);
  assert.deepEqual(
    handed.calls.map(({ words }) => words),
    [ownWords(m, record.checking as string)],
  );
  assert.deepEqual(record.release, RELEASE);
  // The server: in its own process, as before — the registry here refuses at once, and the day is recorded.
  const server = machine();
  await due(server);
  const serverHanded = recorder();
  await checkForUpdates(server.core, server.env, { handOff: { locate: () => null, start: serverHanded.start } });
  assert.equal(serverHanded.calls.length, 0, 'the server started something');
  const asked = await readUpdateCheck(server.stateDir);
  assert.equal(asked.checking, null);
  assert.notEqual(asked.lastChecked, null);
  assert.match(String(asked.lastError), /could not be reached/);
  assert.deepEqual(asked.release, RELEASE);
});

test("a spawn that fails falls back to the channel's own check", async () => {
  // Core's CLI does not start: the command's own child is started next.
  const m = machine();
  await due(m);
  const handed = recorder((_words, call) => call > 1);
  await terminalUpdateHooks(m.core, m.env, { handOff: { start: handed.start }, childEntry: OWN }).check?.();
  const record = await readUpdateCheck(m.stateDir);
  const claimedAt = record.checking as string;
  assert.equal(handed.calls.length, 2, JSON.stringify(handed.calls.map(({ words }) => words)));
  assertCoreWords(m, (handed.calls[0] as Started).words, claimedAt);
  assert.deepEqual((handed.calls[1] as Started).words, ownWords(m, claimedAt));
  // Neither starts: the command asks in its own process, under the same claim.
  const neither = machine();
  await due(neither);
  const refused = recorder(() => false);
  await terminalUpdateHooks(neither.core, neither.env, {
    handOff: { start: refused.start },
    childEntry: OWN,
  }).check?.();
  assert.equal(refused.calls.length, 2);
  const claimed = (refused.calls[0] as Started).words.at(-1);
  const asked = await readUpdateCheck(neither.stateDir);
  assert.deepEqual([asked.lastChecked, asked.checking], [claimed, null]);
  assert.match(String(asked.lastError), /could not be reached/);
  // The server: in its own process.
  const server = machine();
  await due(server);
  const serverRefused = recorder(() => false);
  await checkForUpdates(server.core, server.env, { handOff: { start: serverRefused.start } });
  assert.equal(serverRefused.calls.length, 1);
  const serverAsked = await readUpdateCheck(server.stateDir);
  assert.deepEqual(
    [serverAsked.lastChecked, serverAsked.checking],
    [(serverRefused.calls[0] as Started).words.at(-1), null],
  );
  assert.match(String(serverAsked.lastError), /could not be reached/);
});

test("a located core command that cannot be spawned without a shell falls back to the channel's own check", async () => {
  /*
   * Review Focus 2. On Windows a managed shim is a `.cmd`, and Node refuses to start one without a shell (EINVAL,
   * thrown as `spawn` is called); a path with a space in it is where that shim sits for many people. Elsewhere, a
   * program that is not there, which `spawn` reports a tick later. Either way the real start says false, and throws
   * nothing.
   */
  const dir = tempDir('comms-update-handoff-unstartable-');
  let program: string;
  if (process.platform === 'win32') {
    const spaced = join(dir, 'with space');
    mkdirSync(spaced);
    program = join(spaced, 'agentcomms.cmd');
    writeFileSync(program, '@echo off\r\nexit /b 0\r\n');
  } else {
    program = join(dir, 'not-there');
  }
  const m = machine();
  await due(m);
  const results: boolean[] = [];
  const handed = recorder(async (words, call) => {
    if (call > 1) return true;
    const started = await startCheckChild(words, updateCheckChildEnvironment(m.env), Date.now() + 10_000);
    results.push(started);
    return started;
  });
  await terminalUpdateHooks(m.core, m.env, {
    handOff: { locate: (_core, claimedAt) => [program, UPDATE_CHECK_CHILD_COMMAND, claimedAt], start: handed.start },
    childEntry: OWN,
  }).check?.();
  assert.deepEqual(results, [false], 'the program started');
  const record = await readUpdateCheck(m.stateDir);
  assert.deepEqual(
    handed.calls.map(({ words }) => words),
    [[program, UPDATE_CHECK_CHILD_COMMAND, record.checking], ownWords(m, record.checking as string)],
  );
  // And on its own: false, at once, never thrown.
  assert.equal(
    await startCheckChild([program, UPDATE_CHECK_CHILD_COMMAND, new Date().toISOString()], {}, Date.now() + 10_000),
    false,
  );
});

test('a located core command that starts and fails at once falls back, for the command and for the server', async () => {
  /*
   * 0.26.0 review B, finding 3. Core's stable launcher naming a Node that was removed: the program starts, and ends at
   * once, 127, before it says the ask is over. Counted as handed, the claim sat out its lease and nothing was recorded,
   * every day. A child that ends with a code other than 0, or by a signal, before it says `settled` asked nothing, so
   * the claim is still this process's: the channel's own child is started next, then the check in this process.
   */
  const fails = (claimedAt: string) => [
    process.execPath,
    '-e',
    'process.exit(127)',
    UPDATE_CHECK_CHILD_COMMAND,
    claimedAt,
  ];
  const env = updateCheckChildEnvironment(machine().env);
  const soon = () => Date.now() + 10_000;
  assert.equal(
    await startCheckChild(fails(new Date().toISOString()), env, soon()),
    false,
    'exit 127 counted as started',
  );
  assert.equal(
    await startCheckChild([process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"], env, soon()),
    false,
    'killed by a signal, counted as started',
  );
  // A child that said the ask is over did ask, however it ends; one that ends with 0 finished.
  const said = "process.send({ type: 'settled' }, () => process.exit(3))";
  assert.equal(await startCheckChild([process.execPath, '-e', said], env, soon()), true, 'settled, then 3');
  assert.equal(await startCheckChild([process.execPath, '-e', 'process.exit(0)'], env, soon()), true, 'exit 0');

  // The command: core's command fails at once, and the channel's own child is started next.
  const m = machine();
  await due(m);
  const results: boolean[] = [];
  const handed = recorder(async (words, call) => {
    if (call > 1) return true;
    const started = await startCheckChild(words, updateCheckChildEnvironment(m.env), soon());
    results.push(started);
    return started;
  });
  await terminalUpdateHooks(m.core, m.env, {
    handOff: { locate: (_core, claimedAt) => fails(claimedAt), start: handed.start },
    childEntry: OWN,
  }).check?.();
  assert.deepEqual(results, [false], 'core’s command counted as started');
  const record = await readUpdateCheck(m.stateDir);
  assert.deepEqual(
    handed.calls.map(({ words }) => words),
    [fails(record.checking as string), ownWords(m, record.checking as string)],
  );

  // The server, with the real start: it asks in its own process, and the day is recorded under its claim.
  const server = machine();
  await due(server);
  const outcome = await checkForUpdates(server.core, server.env, {
    handOff: { locate: (_core, claimedAt) => fails(claimedAt) },
  });
  assert.equal(outcome.asked, true);
  const asked = await readUpdateCheck(server.stateDir);
  assert.equal(asked.checking, null, 'the claim sat, unasked');
  assert.notEqual(asked.lastChecked, null);
  assert.match(String(asked.lastError), /could not be reached/);
  assert.deepEqual(asked.release, RELEASE);
});

test("core's own process never hands its check to itself", async () => {
  const claimedAt = new Date().toISOString();
  const own = machine(CORE_CALLER);
  assert.equal(coreUpdateCheckWords(own.core, claimedAt), null);
  // A core opened with no caller locates nothing, and says so with null rather than throwing.
  const bare = machine('none').core;
  assert.equal(bare.handoffs, undefined);
  assert.equal(coreUpdateCheckWords(bare, claimedAt), null);
  // A channel's core does locate it: the null above is not every core's.
  const channel = machine();
  assertCoreWords(channel, coreUpdateCheckWords(channel.core, claimedAt) ?? [], claimedAt);
  // Handed the hand-off anyway, core's command starts only its own child.
  await due(own);
  const handed = recorder();
  await terminalUpdateHooks(own.core, own.env, { handOff: { start: handed.start }, childEntry: OWN }).check?.();
  const record = await readUpdateCheck(own.stateDir);
  assert.deepEqual(
    handed.calls.map(({ words }) => words),
    [ownWords(own, record.checking as string)],
  );
});

test("core's command is located for this process's own system, whatever shell its commands are printed for", async () => {
  /*
   * A channel's core can be opened to print for another shell — a test pins one, and so may a caller. The words handed
   * on are started here, though, so they are located for this system: a managed runtime's stable launcher is a script
   * Node runs on Windows (`node <launcher> …`) and a program of its own elsewhere (`<launcher> …`). Located for the
   * other, a POSIX machine would start Node on a shell script, which starts, fails, and leaves the claim unasked.
   */
  const home = realTemp('comms-update-handoff-managed-');
  const dataDir = join(home, 'data');
  const gmail = writeManaged(dataDir, 'gmail');
  // Core as the Gmail runtime carries it, and core's own runtime behind its stable launcher, at this same release.
  const runtimeOf = (root: string) => join(root, '..', '..', '..');
  writePackage(join(runtimeOf(gmail.root), 'node_modules', '@agentcomms', 'core'), 'core', { files: ['dist/cli.mjs'] });
  const coreRuntime = writeManaged(dataDir, 'core');
  await writeLauncher(dataDir, 'core', process.execPath);
  await switchPointer(dataDir, 'core', runtimeOf(coreRuntime.root));
  const { launcher } = launcherPaths(dataDir, 'core');
  const configDir = join(home, 'config');
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_DATA_DIR: dataDir,
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
  };
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  const caller = { url: moduleUrl(gmail.root, 'dist', 'cli.mjs'), packageName: '@agentcomms/gmail' };
  const core = openCore({ env, platform: other, caller });
  assert.equal(core.handoffs?.platform, other);
  const claimedAt = new Date().toISOString();
  const words = coreUpdateCheckWords(core, claimedAt) ?? [];
  if (process.platform === 'win32') {
    assert.equal(realpathSync(words[0] as string), realpathSync(process.execPath), JSON.stringify(words));
    assert.equal(words[1], launcher, JSON.stringify(words));
  } else {
    assert.equal(words[0], launcher, JSON.stringify(words));
  }
  assert.deepEqual(words.slice(-2), [UPDATE_CHECK_CHILD_COMMAND, claimedAt]);
});

test("the hand-off's environment is the command's child environment", async () => {
  // A debugger given through NODE_OPTIONS stays with the command: core's child would wait for it until its claim ran out.
  for (const surface of ['command', 'server'] as const) {
    const m = machine(GMAIL_CALLER, { NODE_OPTIONS: '--inspect-brk --no-warnings' });
    await due(m);
    const handed = recorder();
    if (surface === 'command') {
      await terminalUpdateHooks(m.core, m.env, { handOff: { start: handed.start }, childEntry: OWN }).check?.();
    } else {
      await checkForUpdates(m.core, m.env, { handOff: { start: handed.start } });
    }
    assert.equal(handed.calls.length, 1, surface);
    const { env } = handed.calls[0] as Started;
    assert.equal(env.NODE_OPTIONS, '--no-warnings', surface);
    assert.deepEqual(env, updateCheckChildEnvironment(m.env), surface);
  }
});

test("core's CLI, started by a channel's server, asks under the channel's claim and gives it up", async () => {
  /*
   * The hand-off as it runs: the real start, and core's real CLI from this checkout, which finishes the ask under the
   * claim it was handed — here a registry nobody answers, so the day is recorded with why, before any release is read
   * or verified. Had core's CLI not started, the server would have asked itself; the start's own answer says it did.
   */
  const m = machine();
  await due(m);
  const started: { words: string[]; started: boolean }[] = [];
  await checkForUpdates(m.core, m.env, {
    handOff: {
      start: async (words, env, deadline) => {
        const result = await startCheckChild(words, env, deadline);
        started.push({ words: [...words], started: result });
        return result;
      },
    },
  });
  assert.equal(started.length, 1);
  const [{ words, started: didStart }] = started as [{ words: string[]; started: boolean }];
  assert.equal(didStart, true, 'core’s CLI did not start');
  const record = await readUpdateCheck(m.stateDir);
  assert.deepEqual([record.lastChecked, record.checking], [words.at(-1), null], JSON.stringify(record));
  assert.match(String(record.lastError), /could not be reached/);
  assert.deepEqual(record.release, RELEASE);
});
