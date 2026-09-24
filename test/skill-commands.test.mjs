import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Every command a skill or readme promises, against the CLI that exists.
 *
 * `docs/superpowers/specs/2026-09-19-slack-design.md` §7 asks for "an audit of every skill document against the
 * code it describes" before S6 merges. Done by hand, that audit is done once and then claimed for ever; done
 * here, it is done on every push.
 *
 * It is not hypothetical. The Slack skills were written documenting `agent-slack draft create` and
 * `agent-slack post prepare` while neither existed, and every other check passed — the operations underneath had
 * tests, and the tests called them directly. A skill that teaches a command nobody can run is worse than a
 * missing skill: the reader concludes the tool is broken rather than that the page is.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

/**
 * The commands a document promises, read from its code rather than from its prose.
 *
 * Prose mentions commands in passing — "`agent-slack doctor` says something is wrong" — and a pattern that takes
 * the next two words out of a sentence invents `doctor says`. What a reader actually *runs* appears in a fenced
 * block or a backticked span, so that is where this looks. Words are taken until one starts with a flag or a
 * placeholder, because that is where the command ends and its arguments begin.
 */
function promisedCommands(text, binary) {
  const code = [
    ...[...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(([, body]) => body),
    ...[...text.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span),
  ].join('\n');

  const found = new Set();
  for (const [, tail] of code.matchAll(new RegExp(`${binary}\\s+([^\`\\n]*)`, 'g'))) {
    const words = [];
    for (const word of tail.trim().split(/\s+/)) {
      if (!/^[a-z][a-z-]*$/.test(word) || words.length === 2) break;
      words.push(word);
    }
    if (words.length > 0) found.add(words.join(' '));
  }
  return found;
}

/**
 * Whether `<binary> <argv…>` is a real command.
 *
 * Not "did `--help` exit zero". Commander answers an *unknown subcommand* by printing its parent's help and
 * exiting 0 — so `agent-slack post schedule --help` succeeds and prints the help for `post`. The first version of
 * this check believed it, which made the whole audit pass for a command that does not exist. What distinguishes
 * them is the `Usage:` line: it names the command that actually ran.
 */
async function exists(entry, binary, argv) {
  let output;
  try {
    const result = await run(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(ROOT, entry), ...argv, '--help'],
      { env: { ...process.env, NO_COLOR: '1' } },
    );
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (/unknown command|error: unknown/i.test(output)) return false;
  const usage = /^Usage:\s*(.+)$/m.exec(output)?.[1] ?? '';
  return usage.startsWith([binary, ...argv].join(' '));
}

for (const cli of [
  { binary: 'agent-slack', entry: 'packages/slack/src/cli.ts', prefix: 'slack-', readme: 'packages/slack/README.md' },
  { binary: 'agent-gmail', entry: 'packages/gmail/src/cli.ts', prefix: 'gmail-', readme: 'packages/gmail/README.md' },
]) {
  test(`every ${cli.binary} command the skills and readme promise actually exists`, async () => {
    const dirs = (await readdir(join(ROOT, 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(cli.prefix))
      .map((entry) => join(ROOT, 'skills', entry.name, 'SKILL.md'));

    const promised = new Set();
    for (const file of [...dirs, join(ROOT, cli.readme)]) {
      const text = await readFile(file, 'utf8');
      for (const command of promisedCommands(text, cli.binary)) promised.add(command);
    }
    assert.ok(promised.size > 0, `no ${cli.binary} commands found to check — the pattern is wrong`);

    const missing = [];
    for (const command of [...promised].sort()) {
      if (!(await exists(cli.entry, cli.binary, command.split(' ')))) missing.push(command);
    }
    assert.deepEqual(missing, [], `documented but not implemented: ${missing.join(', ')}`);
  });
}
