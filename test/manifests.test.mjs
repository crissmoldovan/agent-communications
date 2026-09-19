import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, constants, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The manifests are the only part of this project nobody runs during development: a plugin manifest is read by a
 * host, an extension by another, and the launcher by whichever of them starts the server. A typo in any of them
 * surfaces as "the server failed to start", with nothing to act on, on somebody else's machine.
 *
 * So each is checked here for the things that are true by construction or not at all.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

test('the plugin manifest lists every skill that exists, and only those', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const plugin = manifest.plugins?.[0];
  assert.ok(plugin, 'the marketplace should carry one plugin');

  const onDisk = (await readdir(join(ROOT, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('gmail-'))
    .map((entry) => `./skills/${entry.name}`)
    .sort();
  assert.deepEqual(
    [...plugin.skills].sort(),
    onDisk,
    'a skill added without being listed here is a skill the plugin does not install',
  );

  for (const path of plugin.skills) {
    await access(join(ROOT, path, 'SKILL.md'), constants.R_OK);
  }
});

test('the launcher is executable, runnable by sh, and pins the released version', async () => {
  const path = join(ROOT, 'bin', 'agent-gmail-launch');
  await access(path, constants.X_OK);

  const source = await readFile(path, 'utf8');
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.match(source, new RegExp(`VERSION="${root.version.replace(/\./g, '\\.')}"`));
  assert.match(source, /@cloudpixel\/gmail-mcp@\$VERSION/, 'the pinned target uses the version it declares');

  // `sh -n` parses without running: a syntax error here is a server that never starts, on a machine that is not this one.
  await run('/bin/sh', ['-n', path]);
});

test('the launcher needs no external command to say it cannot find Node', async () => {
  const source = await readFile(join(ROOT, 'bin', 'agent-gmail-launch'), 'utf8');

  // This cannot be tested by running it: the probe list includes absolute system directories, so on any machine
  // that has Node anywhere it finds one. What can be checked is the property that makes the failure path work —
  // that it uses only shell builtins. `cat`, `ls`, `sort`, `tail` and `dirname` all live on PATH, and PATH being
  // nearly empty is the situation this script exists for, so reaching for one of them is how the useful error
  // message becomes "command not found" three times over.
  const forbidden = ['cat ', 'ls ', 'sort ', 'tail ', 'dirname ', 'grep ', 'sed ', 'awk '];
  const lines = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.trim());
  for (const command of forbidden) {
    const offender = lines.find((line) => line.includes(`$(${command.trim()} `) || line.startsWith(command));
    assert.equal(offender, undefined, `the launcher must not need ${command.trim()}: ${offender}`);
  }

  assert.match(source, /could not find Node/, 'and it says so plainly');
  assert.match(source, /agent-gmail mcp install/, 'and names the way out');
  assert.match(source, /exit 127/, 'with the status a host reports for a missing interpreter');
});

test('the Gemini extension launches the version it declares', async () => {
  const extension = JSON.parse(await readFile(join(ROOT, 'gemini-extension.json'), 'utf8'));
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(extension.version, root.version);
  assert.ok(
    extension.mcpServers.gmail.args.includes(`@cloudpixel/gmail-mcp@${root.version}`),
    'the extension should start the version it says it is',
  );
});
