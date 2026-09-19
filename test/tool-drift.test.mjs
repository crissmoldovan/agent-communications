import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Documentation that names a tool which does not exist is worse than no documentation: an agent follows it, the call
 * fails, and the agent concludes the mailbox is broken rather than that the skill is wrong. The reverse is nearly as
 * bad — a tool nothing documents is a tool nobody uses, and it still has to be maintained.
 *
 * So this test reads the tools and commands that actually exist from the source that registers them, reads every name
 * the skills and the README use, and fails when the two disagree in either direction.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every `gmail_*` tool the MCP server registers. Read from the registration calls, not from a list kept beside them. */
async function registeredTools() {
  const source = await readFile(join(ROOT, 'packages/gmail/src/mcp/server.ts'), 'utf8');
  const names = [...source.matchAll(/registerTool\(\s*'(gmail_[a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(names.length > 10, 'the tool registrations should be readable from the server source');
  return new Set(names);
}

/**
 * Every command path the CLI defines, as `agent-gmail <path>`.
 *
 * Commander nests, so a subcommand's full path is its parent's plus its own. The parents are read from the
 * `program.command('x')` calls that are assigned to a variable, which is how this CLI spells a command group.
 */
async function definedCommands() {
  const source = await readFile(join(ROOT, 'packages/gmail/src/cli/program.ts'), 'utf8');
  const groups = new Map();
  for (const match of source.matchAll(/const (\w+) = program\s*\.command\('([a-z-]+)'\)/g)) {
    groups.set(match[1], match[2]);
  }
  const paths = new Set();
  for (const match of source.matchAll(/(?:^|[\s(])(\w+)\s*\.command\('([a-z-]+)/gm)) {
    const receiver = match[1];
    const name = match[2];
    if (receiver === 'program') paths.add(name);
    else if (groups.has(receiver)) paths.add(`${groups.get(receiver)} ${name}`);
  }
  // `withDraftOptions(draft.command('new')…)` and friends wrap the call, so pick those up too.
  for (const match of source.matchAll(/\w+\(\s*(\w+)\s*\.command\('([a-z-]+)/g)) {
    const receiver = match[1];
    if (groups.has(receiver)) paths.add(`${groups.get(receiver)} ${match[2]}`);
  }
  for (const match of source.matchAll(/\.alias\('([a-z-]+)'\)/g)) paths.add(match[1]);
  assert.ok(paths.size > 15, 'the CLI commands should be readable from the program source');
  return paths;
}

/**
 * Only the parts of a document that claim to be commands: fenced blocks and inline code spans.
 *
 * Prose says things like "install agent-gmail and connect a mailbox", where "and" is a word rather than a
 * subcommand. Reading those as commands made the check cry wolf, and a check that cries wolf gets turned off.
 */
function codeOnly(text) {
  const fenced = [...text.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
  const inline = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...fenced, ...inline].join('\n');
}

async function documentation() {
  const files = [join(ROOT, 'README.md')];
  const skills = join(ROOT, 'skills');
  for (const entry of await readdir(skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(skills, entry.name);
    for (const file of await readdir(directory, { recursive: true })) {
      if (extname(file) === '.md') files.push(join(directory, file));
    }
  }
  return files;
}

test('every gmail_ tool named in the docs is one the server registers', async () => {
  const tools = await registeredTools();
  const offenders = [];
  for (const file of await documentation()) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/\bgmail_[a-z_]+/g)) {
      if (!tools.has(match[0])) offenders.push(`${relative(ROOT, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `documented tools that do not exist:\n${offenders.join('\n')}`);
});

test('every agent-gmail command named in the docs is one the CLI defines', async () => {
  const commands = await definedCommands();
  const offenders = [];
  for (const file of await documentation()) {
    const text = codeOnly(await readFile(file, 'utf8'));
    // A leading `-` is a flag, not a subcommand: `agent-gmail --json` names no command at all.
    for (const match of text.matchAll(/agent-gmail\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
      const [, first, second] = match;
      // A two-word form counts if the pair is a command, or if the first word is a command on its own and the
      // second is one of its arguments.
      if (commands.has(`${first} ${second}`) || commands.has(first)) continue;
      offenders.push(`${relative(ROOT, file)}: agent-gmail ${first}${second ? ` ${second}` : ''}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `documented commands that do not exist:\n${offenders.join('\n')}`);
});

test('every tool the server registers is documented somewhere', async () => {
  const tools = await registeredTools();
  const documented = new Set();
  for (const file of await documentation()) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/\bgmail_[a-z_]+/g)) documented.add(match[0]);
  }
  const undocumented = [...tools].filter((tool) => !documented.has(tool)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `these tools exist and no skill or the README mentions them, so nobody will use them:\n${undocumented.join('\n')}`,
  );
});
