import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * What the documents tell a person to run to register, re-register and tidy up the MCP server, against what the
 * CLIs do.
 *
 * Each of these was wrong in a way nothing else caught, because the code they describe had changed under them and
 * had its own tests. The plugin's description said `npx -y @agentcomms/slack mcp install`, which has needed
 * `--client` since the CLIs stopped writing into a client nobody named: exit 64 on the first thing a new user
 * runs. The troubleshooting page offered `mcp install --list`, a flag that never existed, and a `jq` filter on
 * `.name`, a field no check has. Its "re-register" commands, and the setup skill's fix for `mcp-command`, are
 * refused for an entry that is already there unless they carry `--force`. And four pages promised `mcp prune`
 * never removes a runtime "any client registers", which is more than any config scan can see.
 *
 * `docs/reference` is left out because it is generated from the CLIs themselves, and the design specs and the
 * changelog because they record what was true when they were written.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

async function markdownUnder(directory) {
  const found = [];
  for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

async function documents() {
  const files = [
    ...(await markdownUnder('docs')).filter((path) => !/[/\\](?:reference|superpowers)[/\\]/.test(path)),
    ...(await markdownUnder('skills')),
    join(ROOT, 'README.md'),
    join(ROOT, 'packages', 'gmail', 'README.md'),
    join(ROOT, 'packages', 'gmail-mcp', 'README.md'),
    join(ROOT, 'packages', 'slack', 'README.md'),
    join(ROOT, '.claude-plugin', 'marketplace.json'),
    join(ROOT, 'gemini-extension.json'),
  ];
  return Promise.all(files.map(async (path) => ({ path: relative(ROOT, path), text: await readFile(path, 'utf8') })));
}

/** Every `mcp install` a document gives, with the CLI it belongs to and the flags it passes. */
function installCommands(text) {
  const found = [];
  const pattern = /(agent-gmail|agent-slack|@agentcomms\/(?:gmail|slack)(?:@\S+)?) mcp install([^`|"\n]*)/g;
  for (const [command, binary, tail] of text.matchAll(pattern)) {
    const words = (tail.split('#')[0] ?? '').trim().split(/\s+/).filter(Boolean);
    found.push({
      command: command.trim(),
      cli: binary.includes('slack') ? 'slack' : 'gmail',
      flags: words.filter((word) => word.startsWith('--')),
    });
  }
  return found;
}

/** The flags `mcp install --help` lists, read with a scratch home: `--help` reads no config, and must not start to. */
async function installFlags(cli) {
  const home = await mkdtemp(join(tmpdir(), 'install-docs-'));
  const { stdout } = await run(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      join(ROOT, 'packages', cli, 'src', 'cli.ts'),
      'mcp',
      'install',
      '--help',
    ],
    { env: { PATH: process.env.PATH ?? '', HOME: home, AGENT_COMMS_CONFIG_DIR: join(home, 'config'), NO_COLOR: '1' } },
  ).finally(() => rm(home, { recursive: true, force: true }));
  return new Set(stdout.match(/--[a-z][a-z-]*/g) ?? []);
}

test('every `mcp install` a document gives names a client, and passes only flags the CLI has', async () => {
  const known = { gmail: await installFlags('gmail'), slack: await installFlags('slack') };
  assert.ok(known.gmail.has('--client') && known.slack.has('--force'), 'the help text was not read');

  const wrong = [];
  let seen = 0;
  for (const { path, text } of await documents()) {
    for (const { command, cli, flags } of installCommands(text)) {
      seen += 1;
      if (!flags.includes('--client')) wrong.push(`${path}: ${command} has no --client`);
      for (const flag of flags) if (!known[cli].has(flag)) wrong.push(`${path}: ${command} passes ${flag}`);
    }
  }
  assert.ok(seen > 10, `only ${seen} commands found — the pattern is wrong`);
  assert.deepEqual(wrong, []);
});

test("a command that re-registers an entry that is already there carries --force, or is doctor's own fix", async () => {
  const wrong = [];
  for (const { path, text } of await documents()) {
    for (const line of text.split('\n')) {
      if (!/mcp install/.test(line) || !/re-?register|rewrites|re-run|mcp-command/i.test(line)) continue;
      if (/--force|the `fix`/.test(line)) continue;
      wrong.push(`${path}: ${line.trim()}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('doctor checks are picked out by id, the field every check has', async () => {
  const wrong = [];
  for (const { path, text } of await documents()) {
    for (const line of text.split('\n')) {
      if (/doctor/.test(line) && /select\(\.name\b/.test(line)) wrong.push(`${path}: ${line.trim()}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('no document promises that prune keeps whatever any client registers', async () => {
  const wrong = [];
  for (const { path, text } of await documents()) {
    // Prose wraps, so the words are matched across line breaks.
    const prose = text.replace(/\s+/g, ' ');
    for (const [promise] of prose.matchAll(
      /\b(?:any|no) (?:MCP )?client registers\b|keeps anything a client registers/gi,
    )) {
      wrong.push(`${path}: ${promise}`);
    }
  }
  assert.deepEqual(wrong, []);
});
