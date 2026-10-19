import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SERVERS, serverFacts } from '../src/channel-servers.ts';
import {
  fallbackRecordPath,
  launcherName,
  launcherPaths,
  readFallback,
  readPointer,
  registeredLauncher,
  restorePointer,
  rollbackPointer,
  switchPointer,
  writeLauncher,
} from '../src/launcher.ts';
import { managedRuntimeDir, managedRuntimeEntry } from '../src/mcp-install.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The stable launcher (design 2026-10-16, U6): a registration and a shim start `<data>/launch/<name>`, which reads the
 * pointer beside it, `<name>.current`, and runs the runtime that names with the Node it was written for. An update then
 * switches the pointer — one rename — and edits no client's configuration.
 *
 * Every runtime here is a directory the test makes, whose CLI prints which runtime it is and the words it was given.
 * Nothing is installed, and no client is touched.
 */

const POSIX = process.platform === 'win32' ? { skip: 'WINDOWS_SKIP: the POSIX launcher is a shell script' } : {};

/** A runtime of `name` at `version` whose CLI prints `{ runtime, argv }`, or none at all with `cli: false`. */
function runtime(data: string, name: string, version: string, options: { cli?: boolean } = {}): string {
  const packageName = `@agentcomms/${name}`;
  const root = managedRuntimeDir(data, packageName, version);
  const entry = managedRuntimeEntry(data, packageName, version);
  mkdirSync(join(entry, '..'), { recursive: true });
  if (options.cli !== false) {
    writeFileSync(
      entry,
      `process.stdout.write(JSON.stringify({ runtime: ${JSON.stringify(version)}, argv: process.argv.slice(2) }));\n`,
    );
  }
  return root;
}

/** Runs a launcher as a client would: its own program on POSIX, under Node on Windows. */
function launch(data: string, name: string, args: string[], platform: NodeJS.Platform = process.platform) {
  const { launcher } = launcherPaths(data, name);
  const result =
    platform === 'win32'
      ? spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnSync(launcher, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = result.stdout.trim();
  return {
    status: result.status,
    stderr: result.stderr,
    ran: out === '' ? null : (JSON.parse(out) as { runtime: string; argv: string[] }),
  };
}

test('a launcher and its pointer live at <data>/launch/<name> and <name>.current, and a name is never a path', () => {
  const data = tempDir();
  assert.deepEqual(launcherPaths(data, 'gmail'), {
    launcher: join(data, 'launch', 'gmail'),
    pointer: join(data, 'launch', 'gmail.current'),
  });
  for (const name of ['../gmail', 'gmail/x', '', 'Gmail', '.current', 'a b']) {
    assert.throws(() => launcherPaths(data, name), /not a launcher name/, JSON.stringify(name));
  }
  // Every declared server's launcher is named for its package, and runs the CLI its managed runtime holds.
  for (const server of SERVERS) {
    const { packageName } = serverFacts(server);
    const name = launcherName(packageName);
    assert.equal(packageName, `@agentcomms/${name}`);
    runtime(data, name, '1.0.0');
  }
});

test('a switch records the runtime it replaces as previous, and a switch to the same runtime keeps it', async () => {
  const data = tempDir();
  const a = runtime(data, 'gmail', '0.19.0');
  const b = runtime(data, 'gmail', '0.20.0');
  assert.equal(await readPointer(data, 'gmail'), undefined, 'no pointer yet');
  await switchPointer(data, 'gmail', a);
  assert.deepEqual(await readPointer(data, 'gmail'), { current: a });
  await switchPointer(data, 'gmail', b);
  assert.deepEqual(await readPointer(data, 'gmail'), { current: b, previous: a });
  await switchPointer(data, 'gmail', b);
  assert.deepEqual(await readPointer(data, 'gmail'), { current: b, previous: a }, 'the runtime to go back to is kept');
});

test('a pointer switch is atomic: a reader at any moment finds the old pointer or the new, whole', async () => {
  const data = tempDir();
  const a = runtime(data, 'slack', '0.19.0');
  const b = runtime(data, 'slack', '0.20.0');
  await switchPointer(data, 'slack', a);
  const { pointer } = launcherPaths(data, 'slack');
  // Another process reads the pointer as fast as it can while this one switches it back and forth.
  const reader = spawn(
    process.execPath,
    [
      '-e',
      `const { readFileSync } = require('node:fs');
       const wanted = new Set(${JSON.stringify(['0.19.0-slack', '0.20.0-slack'])});
       let reads = 0, bad = [];
       const until = Date.now() + 4000;
       process.stdin.on('data', () => { process.stdout.write(JSON.stringify({ reads, bad })); process.exit(0); });
       (function look() {
         for (let i = 0; i < 200; i++) {
           let text;
           try { text = readFileSync(${JSON.stringify(pointer)}, 'utf8'); } catch (error) { bad.push(String(error.code)); continue; }
           reads++;
           const current = /^current=(.*)$/m.exec(text)?.[1];
           if (!wanted.has(current) || !text.endsWith('\\n')) bad.push(JSON.stringify(text));
         }
         if (Date.now() < until) setImmediate(look);
       })();`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  let out = '';
  reader.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  const done = new Promise((resolve) => reader.once('exit', resolve));
  for (let index = 0; index < 150; index += 1) await switchPointer(data, 'slack', index % 2 === 0 ? b : a);
  reader.stdin.write('stop\n');
  await done;
  const seen = JSON.parse(out) as { reads: number; bad: string[] };
  assert.ok(seen.reads > 0, 'the reader read the pointer while it was being switched');
  assert.deepEqual(seen.bad.slice(0, 5), [], 'no read found the pointer missing, empty or half-written');
  // Nothing of the switches is left behind beside it: each wrote a temporary file and renamed it over the pointer.
  assert.deepEqual(readdirSync(join(data, 'launch')).sort(), ['slack.current']);
});

test('a switch that cannot be written leaves the pointer as it was', POSIX, async () => {
  const data = tempDir();
  const a = runtime(data, 'gmail', '0.19.0');
  const b = runtime(data, 'gmail', '0.20.0');
  await switchPointer(data, 'gmail', a);
  const { pointer } = launcherPaths(data, 'gmail');
  const before = readFileSync(pointer, 'utf8');
  chmodSync(join(data, 'launch'), 0o500);
  try {
    await assert.rejects(switchPointer(data, 'gmail', b));
  } finally {
    chmodSync(join(data, 'launch'), 0o700);
  }
  assert.equal(readFileSync(pointer, 'utf8'), before, 'the pointer is the one it was');
  assert.deepEqual(readdirSync(join(data, 'launch')).sort(), ['gmail.current'], 'and nothing half-made is beside it');
});

test('a switch to anything but a runtime of this launcher, with its CLI in place, is refused and changes nothing', async () => {
  const data = tempDir();
  const a = runtime(data, 'gmail', '0.19.0');
  await switchPointer(data, 'gmail', a);
  const before = await readPointer(data, 'gmail');
  const empty = runtime(data, 'gmail', '0.20.0', { cli: false });
  const elsewhere = join(tempDir(), 'runtime', '0.20.0-gmail');
  mkdirSync(elsewhere, { recursive: true });
  const slack = runtime(data, 'slack', '0.20.0');
  for (const target of [
    empty,
    elsewhere,
    slack,
    join(data, 'runtime'),
    join(data, 'runtime', '..', 'runtime', '0.19.0-gmail', 'x'),
  ]) {
    await assert.rejects(switchPointer(data, 'gmail', target), /so the launcher was not switched to it/, target);
  }
  assert.deepEqual(await readPointer(data, 'gmail'), before);
});

test('a pointer that is not one this writes is refused when read, never taken for no pointer', async () => {
  const data = tempDir();
  mkdirSync(join(data, 'launch'), { recursive: true });
  const { pointer } = launcherPaths(data, 'gmail');
  for (const text of ['', 'current=../../etc\n', 'current=0.20.0-slack\n', 'previous=0.19.0-gmail\n']) {
    writeFileSync(pointer, text);
    await assert.rejects(readPointer(data, 'gmail'), /cannot be read as a pointer/, JSON.stringify(text));
  }
});

test('rollback switches back to the previous runtime, and the one it left becomes previous', async () => {
  const data = tempDir();
  const a = runtime(data, 'resend', '0.19.0');
  const b = runtime(data, 'resend', '0.20.0');
  await switchPointer(data, 'resend', a);
  await assert.rejects(rollbackPointer(data, 'resend'), /no previous runtime/);
  await switchPointer(data, 'resend', b);
  assert.deepEqual(await rollbackPointer(data, 'resend'), { from: b, to: a });
  assert.deepEqual(await readPointer(data, 'resend'), { current: a, previous: b });
  // Nothing of either runtime was touched: a rollback is the pointer and nothing else.
  assert.ok(existsSync(managedRuntimeEntry(data, '@agentcomms/resend', '0.20.0')));
  // A previous runtime that is no longer there is not gone back to.
  await switchPointer(data, 'resend', b);
  rmSync(a, { recursive: true });
  await assert.rejects(rollbackPointer(data, 'resend'), /no CLI to start/);
  assert.deepEqual(await readPointer(data, 'resend'), { current: b, previous: a });
  await assert.rejects(rollbackPointer(tempDir(), 'resend'), /no pointer/);
});

test('a restore puts back exactly the pointer before a switch, only while nothing has switched it since', async () => {
  const data = tempDir();
  const a = runtime(data, 'gmail', '0.19.0');
  const b = runtime(data, 'gmail', '0.20.0');
  const c = runtime(data, 'gmail', '0.21.0');
  await switchPointer(data, 'gmail', a);
  const before = await readPointer(data, 'gmail');
  await switchPointer(data, 'gmail', b);
  assert.equal(await restorePointer(data, 'gmail', before, b), true);
  assert.deepEqual(await readPointer(data, 'gmail'), { current: a });
  await switchPointer(data, 'gmail', b);
  await switchPointer(data, 'gmail', c);
  assert.equal(await restorePointer(data, 'gmail', before, b), false, 'another switch came since: it stays');
  assert.deepEqual(await readPointer(data, 'gmail'), { current: c, previous: b });
  // Before the first switch there was no pointer, and a restore to that removes it.
  const fresh = tempDir();
  const d = runtime(fresh, 'gmail', '0.20.0');
  await switchPointer(fresh, 'gmail', d);
  assert.equal(await restorePointer(fresh, 'gmail', undefined, d), true);
  assert.equal(await readPointer(fresh, 'gmail'), undefined);
});

test('the launcher runs the pointed runtime with every word it is given, and follows a switch', POSIX, async () => {
  const data = tempDir();
  const a = runtime(data, 'gmail', '0.19.0');
  const b = runtime(data, 'gmail', '0.20.0');
  await writeLauncher(data, 'gmail', process.execPath);
  await switchPointer(data, 'gmail', a);
  const words = ['--config-dir', join(data, "it's here"), 'mcp', '--inbox', 'acme/gmail', '', '$HOME', '*', '"x"'];
  assert.deepEqual(launch(data, 'gmail', words).ran, { runtime: '0.19.0', argv: words });
  await switchPointer(data, 'gmail', b);
  assert.deepEqual(launch(data, 'gmail', ['mcp']).ran, { runtime: '0.20.0', argv: ['mcp'] });
  // It is an executable file only its owner can change, and it never writes to stdout itself: MCP speaks there.
  const { launcher } = launcherPaths(data, 'gmail');
  assert.equal(lstatSync(launcher).mode & 0o777, 0o700);
  assert.equal(await readFallback(data, 'gmail'), undefined, 'nothing fell back');
});

test('the launcher starts the Node it was written for, as given: a link stays the link', POSIX, async () => {
  const data = tempDir();
  const bin = join(tempDir(), 'bin');
  mkdirSync(bin);
  const link = join(bin, 'node');
  symlinkSync(process.execPath, link);
  runtime(data, 'slack', '0.20.0');
  await writeLauncher(data, 'slack', link);
  await switchPointer(data, 'slack', managedRuntimeDir(data, '@agentcomms/slack', '0.20.0'));
  const source = readFileSync(launcherPaths(data, 'slack').launcher, 'utf8');
  assert.match(source, new RegExp(`node='${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.ok(!source.includes(realpathSync(process.execPath)), 'never the file the link resolves to');
  assert.deepEqual(launch(data, 'slack', ['x']).ran, { runtime: '0.20.0', argv: ['x'] });
  await assert.rejects(writeLauncher(data, 'slack', 'node'), /full path/);
});

for (const platform of ['posix', 'win32'] as const) {
  test(
    `a runtime that fails to start falls back to the previous one, once, and records it (${platform} launcher)`,
    platform === 'posix' ? POSIX : {},
    async () => {
      const data = tempDir();
      const as = platform === 'win32' ? 'win32' : process.platform;
      const a = runtime(data, 'gmail', '0.19.0');
      const b = runtime(data, 'gmail', '0.20.0');
      await writeLauncher(data, 'gmail', process.execPath, { platform: as });
      await switchPointer(data, 'gmail', a);
      await switchPointer(data, 'gmail', b);
      // The new runtime's CLI is gone — removed, half-installed, quarantined: it cannot start.
      rmSync(managedRuntimeEntry(data, '@agentcomms/gmail', '0.20.0'));
      const started = launch(data, 'gmail', ['mcp', '--read-only'], as);
      assert.deepEqual(started.ran, { runtime: '0.19.0', argv: ['mcp', '--read-only'] }, started.stderr);
      assert.equal(started.status, 0);
      const fallback = await readFallback(data, 'gmail');
      assert.equal(fallback?.from, '0.20.0-gmail');
      assert.equal(fallback?.to, '0.19.0-gmail');
      assert.ok(fallback?.at instanceof Date && Number.isFinite(fallback.at.getTime()));
      assert.equal(fallbackRecordPath(data, 'gmail'), join(data, 'launch', 'gmail.fallback'));
      // The pointer is left as the update made it: the launcher only reads it.
      assert.deepEqual(await readPointer(data, 'gmail'), { current: b, previous: a });

      // Once: with the previous runtime gone as well, nothing is started, it says why, and it does not go round again.
      rmSync(fallbackRecordPath(data, 'gmail'));
      rmSync(managedRuntimeEntry(data, '@agentcomms/gmail', '0.19.0'));
      const none = launch(data, 'gmail', ['mcp'], as);
      assert.equal(none.ran, null, 'nothing ran');
      assert.equal(none.status, 78);
      assert.match(none.stderr, /no runtime it can start/);
      assert.match(none.stderr, /0\.20\.0-gmail/);
      assert.equal(await readFallback(data, 'gmail'), undefined, 'a fall back that did not happen is not recorded');

      // With no pointer at all, it says so in the same way.
      rmSync(launcherPaths(data, 'gmail').pointer);
      const unpointed = launch(data, 'gmail', ['mcp'], as);
      assert.equal(unpointed.status, 78);
      assert.match(unpointed.stderr, /no runtime it can start/);
    },
  );
}

test('a runtime whose CLI is there is started and never fallen back from, whatever it then does', POSIX, async () => {
  /*
   * Falling back after the runtime has run would run the same command twice — an approval, a send — so a runtime that
   * starts and then fails is that runtime's failure, said as it says it. Only one that cannot start at all is fallen
   * back from.
   */
  const data = tempDir();
  const a = runtime(data, 'gmail', '0.19.0');
  const b = runtime(data, 'gmail', '0.20.0');
  writeFileSync(
    managedRuntimeEntry(data, '@agentcomms/gmail', '0.20.0'),
    'process.stderr.write("broke"); process.exit(3);\n',
  );
  await writeLauncher(data, 'gmail', process.execPath);
  await switchPointer(data, 'gmail', a);
  await switchPointer(data, 'gmail', b);
  const started = launch(data, 'gmail', ['send']);
  assert.equal(started.status, 3);
  assert.equal(started.ran, null, 'the previous runtime was not run as well');
  assert.equal(started.stderr, 'broke');
  assert.equal(await readFallback(data, 'gmail'), undefined);
});

test('a Windows pointer needs no symlink: the launcher, its pointer and its record are plain files', async () => {
  const data = tempDir();
  const a = runtime(data, 'slack', '0.19.0');
  const b = runtime(data, 'slack', '0.20.0');
  await writeLauncher(data, 'slack', 'C:\\Program Files\\nodejs\\node.exe', { platform: 'win32' });
  await switchPointer(data, 'slack', a);
  await switchPointer(data, 'slack', b);
  // The Windows launcher is a script Node runs, never cmd.exe or PowerShell: nothing re-parses the words it is given.
  const words = ['mcp', '--workspace', 'acme/slack', 'x&whoami', '%PATH%', '^', '"quoted"', ''];
  assert.deepEqual(launch(data, 'slack', words, 'win32').ran, { runtime: '0.20.0', argv: words });
  rmSync(managedRuntimeEntry(data, '@agentcomms/slack', '0.20.0'));
  assert.deepEqual(launch(data, 'slack', ['mcp'], 'win32').ran, { runtime: '0.19.0', argv: ['mcp'] });
  for (const name of readdirSync(join(data, 'launch'))) {
    const info = lstatSync(join(data, 'launch', name));
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${name} is a plain file`);
  }
  assert.deepEqual(readdirSync(join(data, 'launch')).sort(), [
    'package.json',
    'slack',
    'slack.current',
    'slack.fallback',
  ]);
  // The pointer names the runtime by its folder, so nothing in it depends on how Windows spells the data directory.
  assert.equal(
    readFileSync(launcherPaths(data, 'slack').pointer, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n'),
    'current=0.20.0-slack\nprevious=0.19.0-slack\n',
  );
});

test('a registration starts a stable launcher only when it is in the data directory the registration itself pins', () => {
  const data = join(tempDir(), 'data');
  const pins = ['--config-dir', '/c', '--state-dir', '/s', '--data-dir', data, '--secrets-dir', '/x'];
  const launcher = join(data, 'launch', 'gmail');
  assert.deepEqual(registeredLauncher({ command: launcher, args: [...pins, 'mcp'] }), {
    dataDir: data,
    name: 'gmail',
    launcher,
  });
  // On Windows, Node starts it: the launcher is the first word.
  assert.deepEqual(registeredLauncher({ command: 'C:\\node.exe', args: [launcher, ...pins, 'mcp'] }, 'win32'), {
    dataDir: data,
    name: 'gmail',
    launcher,
  });
  assert.deepEqual(registeredLauncher({ command: launcher, args: [`--data-dir=${data}`, 'mcp'] })?.name, 'gmail');
  // A program of the same shape in any other folder is somebody else's.
  assert.equal(registeredLauncher({ command: '/opt/tools/launch/gmail', args: [...pins, 'mcp'] }), null);
  assert.equal(registeredLauncher({ command: launcher, args: ['mcp'] }), null, 'no data directory pinned');
  assert.equal(registeredLauncher({ command: join(data, 'launch', '..', 'gmail'), args: pins }), null);
  assert.equal(registeredLauncher({ command: join(data, 'launch', 'Not a name'), args: pins }), null);
});
