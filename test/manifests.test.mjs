import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, constants, cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PACKAGES } from '../scripts/packages.mjs';

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
  // `claude plugin validate` warns without it, and the description is what a person reads before installing.
  assert.ok(manifest.description?.length > 40, 'the marketplace needs a description');
  assert.ok(plugin.description?.length > 40, 'and so does the plugin');

  /*
   * Every skill directory, not every `gmail-` one.
   *
   * This test exists to catch a skill that was added and not listed — and it could not, because it discovered
   * skills by the same prefix the manifest happened to use. Three Slack skills were on disk, absent from the
   * plugin, and this passed. A skill is a directory with a `SKILL.md`; `_shared` holds the contract they are
   * given and is not one.
   */
  const onDisk = (await readdir(join(ROOT, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
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
  // The executable bit is a POSIX concept; git on Windows checks out without it and the file is not used there.
  if (process.platform !== 'win32') await access(path, constants.X_OK);

  const source = await readFile(path, 'utf8');
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.match(source, new RegExp(`VERSION="${root.version.replace(/\./g, '\\.')}"`));
  assert.match(source, /@agentcomms\/gmail-mcp@\$VERSION/, 'the pinned target uses the version it declares');

  // `sh -n` parses without running: a syntax error here is a server that never starts, on a machine that is not
  // this one. Skipped on Windows, which has no `/bin/sh` — the launcher is the POSIX half of the pair, and the
  // plugin manifest points Windows hosts at `npx` directly.
  if (process.platform !== 'win32') await run('/bin/sh', ['-n', path]);
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
  assert.match(source, /mcp install --client/, 'and names the way out');
  assert.match(source, /exit 127/, 'with the status a host reports for a missing interpreter');
});

test('the launcher prints the whole message when it finds no Node, and nothing else', async (t) => {
  if (process.platform === 'win32') return t.skip('no /bin/sh');
  /*
   * Run, with the search forced to come up empty.
   *
   * The search itself cannot be made to fail here (see above), so the copy replaces its one call with `false` and
   * leaves every line of the failure path exactly as shipped. Reading the source was not enough: a blank line inside
   * the `printf` continuation parsed cleanly under `sh -n`, and at run time turned everything after the first line
   * into a command called "" — the person saw "could not find Node", then "command not found", and none of the
   * explanation.
   */
  const source = await readFile(join(ROOT, 'bin', 'agent-gmail-launch'), 'utf8');
  const call = 'if ! NODE_DIR=$(find_node_dir); then';
  assert.ok(source.includes(call), 'the launcher still decides with one call to find_node_dir');
  const directory = await mkdtemp(join(tmpdir(), 'launcher-'));
  const copy = join(directory, 'agent-gmail-launch');
  await writeFile(copy, source.replace(call, 'if ! NODE_DIR=$(false); then'));

  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const result = await run('/bin/sh', [copy], { env: { PATH: '', HOME: directory } }).then(
    () => assert.fail('it should have exited non-zero'),
    (error) => error,
  );
  assert.equal(result.code, 127);
  assert.doesNotMatch(result.stderr, /not found|No such file/i, 'every line is part of one printf');
  assert.match(result.stderr, /^agent-gmail: could not find Node\.\n\nThis launcher looked on PATH/);
  assert.match(result.stderr, /Node 22\.12 or newer is required/);
  assert.ok(
    result.stderr.includes(`npx -y @agentcomms/gmail@${root.version} mcp install --client <your client>`),
    `the way out, at the version this launcher runs:\n${result.stderr}`,
  );
});

test('the Gemini extension launches the version it declares', async () => {
  const extension = JSON.parse(await readFile(join(ROOT, 'gemini-extension.json'), 'utf8'));
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(extension.version, root.version);
  assert.ok(
    extension.mcpServers.gmail.args.includes(`@agentcomms/gmail-mcp@${root.version}`),
    'the extension should start the version it says it is',
  );
});

test('the Gemini extension starts the Slack server the way it starts Gmail’s, at the same version', async () => {
  /*
   * The extension installed the Slack skills' instructions and no Slack server, so an agent following one found no
   * `slack_*` tools. It is declared exactly as Gmail's is — `npx -y` with an exact version, no prompt and no drift —
   * and `mcp` last, because `@agentcomms/slack` is the whole CLI and without it the process prints help and exits.
   */
  const extension = JSON.parse(await readFile(join(ROOT, 'gemini-extension.json'), 'utf8'));
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const slack = extension.mcpServers.slack;
  assert.ok(slack, 'the extension declares a Slack server');
  assert.equal(slack.command, extension.mcpServers.gmail.command, 'started the same way as Gmail’s');
  assert.deepEqual(slack.args, ['-y', `@agentcomms/slack@${root.version}`, 'mcp']);
  // Gemini reads `contextFileName` at install time, and this one named a file that never existed.
  if (extension.contextFileName) await access(join(ROOT, extension.contextFileName), constants.R_OK);
});

test('a version bump reaches the Slack pin in the Gemini extension', async () => {
  // A pin nothing rewrites is one release from pointing at the previous version — and `--check` passing over it.
  const scratch = await mkdtemp(join(tmpdir(), 'agentcomms-versions-'));
  try {
    for (const path of [
      'package.json',
      'scripts/sync-versions.mjs',
      // What sync-versions imports, and the list of manifests it rewrites — read, not copied out, so a package
      // added there is carried here too.
      'scripts/packages.mjs',
      '.claude-plugin/marketplace.json',
      'gemini-extension.json',
      'bin/agent-gmail-launch',
      'skills',
      ...PACKAGES.map((name) => `packages/${name}/package.json`),
    ]) {
      await cp(join(ROOT, path), join(scratch, path), { recursive: true });
    }
    const root = JSON.parse(await readFile(join(scratch, 'package.json'), 'utf8'));
    await writeFile(join(scratch, 'package.json'), `${JSON.stringify({ ...root, version: '9.9.9' }, null, 2)}\n`);
    await run(process.execPath, [join(scratch, 'scripts', 'sync-versions.mjs')]);
    const extension = JSON.parse(await readFile(join(scratch, 'gemini-extension.json'), 'utf8'));
    assert.deepEqual(extension.mcpServers.slack.args, ['-y', '@agentcomms/slack@9.9.9', 'mcp']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the plugin says how to connect the Slack server it does not start', async () => {
  /*
   * The plugin's Gmail server is started through `bin/agent-gmail-launch`, which finds Node for a host with an empty
   * PATH. There is no Slack launcher, so the plugin declares no Slack server rather than one started differently
   * from Gmail's — and says, where a person reads before installing, how to connect it.
   */
  const manifest = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const plugin = manifest.plugins[0];
  if (!plugin.mcpServers.slack) assert.match(plugin.description, /@agentcomms\/slack mcp install/);
  assert.ok(plugin.keywords.includes('slack'));
});
