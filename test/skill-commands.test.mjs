import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { REGISTRY } from '../scripts/channels.mjs';

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
      { env: { ...process.env, NO_COLOR: '1', AGENT_COMMS_UPDATE_CHECK: 'off' } },
    );
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (/unknown command|error: unknown/i.test(output)) return false;
  const usage = /^Usage:\s*(.+)$/m.exec(output)?.[1] ?? '';
  return usage.startsWith([binary, ...argv].join(' '));
}

/** Every channel's Commander CLI, with the prefix of its skills and its README — from the channel registry. */
const CLIS = REGISTRY.surfaces
  .filter((surface) => surface.cli === 'commander')
  .map((surface) => {
    const family = REGISTRY.skillFamilies.find((each) => each.channel === surface.package);
    return {
      package: surface.package,
      binary: surface.binary,
      entry: surface.entry,
      prefix: family?.prefix,
      readme: family?.readme,
    };
  });

/**
 * A service's CLI (D14) may have no skills family only while its package is held from release: its skill arrives with
 * a later phase (the events daemon's in B3). Once the hold is lifted it is checked like every channel CLI, so a release
 * cannot ship a CLI that no skill names.
 */
const SERVICE_PACKAGES = new Set(
  REGISTRY.services.map((service) => (typeof service === 'string' ? service : service.directory)),
);
const HELD_PACKAGES = new Set(REGISTRY.held.map((held) => (typeof held === 'string' ? held : held.directory)));
const heldServiceWithoutSkills = (cli) =>
  cli.prefix === undefined && SERVICE_PACKAGES.has(cli.package) && HELD_PACKAGES.has(cli.package);

test('every channel CLI is checked here, with the skills that name it', () => {
  assert.ok(CLIS.length >= 2, 'the registry should list the channel CLIs');
  for (const cli of CLIS) {
    if (heldServiceWithoutSkills(cli)) continue;
    assert.ok(cli.prefix && cli.readme, `${cli.binary} has no skills family in its manifest`);
  }
});

for (const cli of CLIS.filter((cli) => !heldServiceWithoutSkills(cli))) {
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

// ── What a skill tells a person to run (CUE-403) ─────────────────────────────────────────────────────────────────

/**
 * Every contract and every skill of every channel, from the channel registry: a new channel's contract and the skills
 * under its prefix are read here from their first commit.
 */
async function skillTexts() {
  const files = REGISTRY.skillFamilies.map((family) => join(ROOT, family.contract));
  for (const entry of await readdir(join(ROOT, 'skills'), { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    // A skill's `references/contract.md` is a copy of its family's contract, which is read once, above.
    if (!entry.isFile() || !entry.name.endsWith('.md') || /[/\\]_shared[/\\]/.test(path)) continue;
    if (/[/\\]references[/\\]contract\.md$/.test(path)) continue;
    if (!REGISTRY.skillFamilies.some((family) => path.includes(`${join('skills', family.prefix)}`))) continue;
    files.push(path);
  }
  return Promise.all(
    [...new Set(files)].map(async (path) => ({ path: relative(ROOT, path), text: await readFile(path, 'utf8') })),
  );
}

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
/** Every command this suite installs, from the manifests: a channel's binary, its server's bins, its approve. */
const SUITE = REGISTRY.channels.flatMap(({ manifest }) => [manifest.binary, ...(manifest.server?.bins ?? [])]);
const NAME = `(?:${SUITE.map(escapeRegExp).join('|')})(?:\\.(?:cmd|exe|ps1|bat))?`;
const PACKAGE = `@agentcomms/[a-z-]+(?:@\\S+)?`;
/**
 * A suite command for a person to run, made up rather than given: each manifest's `approve` (`agent-gmail approve`),
 * in any case and with a Windows extension, or that approve through npx. 0.13.1's approvals hand over the command
 * the result gives — this installation's Node and CLI file, its folders pinned — or say why there is none here.
 */
const APPROVES = REGISTRY.channels.map(({ manifest }) => {
  const [binary, ...words] = manifest.approve.split(' ');
  return new RegExp(
    `(?<![\\w@/-])${escapeRegExp(binary)}(?:\\.(?:cmd|exe|ps1|bat))?\\s+${words.map(escapeRegExp).join('\\s+')}\\b`,
    'i',
  );
});
const NPX_APPROVE = new RegExp(
  `\\b(?:npx|pnpx|bunx|npm exec|pnpm dlx|yarn dlx)\\b[^\`\\n]*${PACKAGE}\\s+approve\\b`,
  'i',
);
/** A person told to run a suite command by its name: "the person runs `agent-whatsapp deny …`". */
const PERSON_RUNS = new RegExp(
  `(?:\\b(?:the person|the user|they)\\s+(?:then\\s+|first\\s+)?(?:runs?|types?|pastes?)|\\b(?:give|hand|tell)\\s+(?:them|the person|the user)|\\bask (?:them|the person|the user) to run)\\s+\`(?:${NAME}|(?:npx|pnpx|bunx)\\b[^\`]*${PACKAGE})(?:\\s|\`)`,
  'i',
);

test('the skills read here are every channel’s contract and every skill under its prefix (CUE-403)', async () => {
  const paths = (await skillTexts()).map(({ path }) => path.split(/[/\\]/).filter(Boolean).join('/'));
  for (const family of REGISTRY.skillFamilies) assert.ok(paths.includes(family.contract), family.contract);
  const read = paths.map((path) => path.split('/').slice(0, 2).join('/'));
  const skills = (await readdir(join(ROOT, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => `skills/${entry.name}`);
  for (const skill of skills) assert.ok(read.includes(skill), `${skill} is read`);
});

test('no skill or contract makes up an approve command: it hands over the one the result gives (CUE-403)', async () => {
  const wrong = new Set();
  for (const { path, text } of await skillTexts()) {
    for (const line of text.split('\n')) {
      if ([...APPROVES, NPX_APPROVE].some((pattern) => pattern.test(line))) wrong.add(`${path}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    [...wrong],
    [],
    `an approve command written by hand instead of the result's:\n${[...wrong].join('\n')}`,
  );
});

test('no skill or contract tells a person to run a suite command by its name (CUE-403)', async () => {
  const wrong = [];
  for (const { path, text } of await skillTexts()) {
    // Prose wraps, so a sentence is read across its line breaks.
    for (const [found] of text.replace(/\s*\n\s*/g, ' ').matchAll(new RegExp(PERSON_RUNS.source, 'gi'))) {
      wrong.push(`${path}: ${found}`);
    }
  }
  assert.deepEqual(wrong, [], `a command handed to a person that is not the one a result gives:\n${wrong.join('\n')}`);
});

// ── The wait and the revoke a skill hands an agent (CUE-404) ─────────────────────────────────────────────────────

/*
 * Design 2026-10-05 §D3: an agent learns of an approval by waiting, and a person's "no" reaches the store only when the
 * agent revokes. Each channel that hands a person approvals (its manifest names an `approve`) teaches both, in the
 * words its own CLI and server have — the rows of `capabilities.json` whose operation is `waitForApproval` or
 * `revokeApproval`: the channel's own, or the core's for a channel with none. Whether each named command and tool
 * exists is `tool-drift`'s; this is that each family names the ones that are its.
 */
const CAPABILITIES = JSON.parse(readFileSync(join(ROOT, 'capabilities.json'), 'utf8')).capabilities;

function handOffs(operation, channel) {
  const own = CAPABILITIES.filter((row) => row.operation === operation && row.package === channel);
  const rows =
    own.length > 0 ? own : CAPABILITIES.filter((row) => row.operation === operation && row.package === 'core');
  return rows.map((row) => {
    const binary = REGISTRY.channels.find((each) => each.directory === row.package)?.manifest.binary;
    return { tool: row.mcp, command: `${binary} ${row.cli}` };
  });
}

test('each channel that hands out approvals names its own wait and its revoke, as tool and as command (CUE-404)', async () => {
  const approving = REGISTRY.skillFamilies.filter(
    (family) => REGISTRY.channels.find((channel) => channel.directory === family.channel)?.manifest.approve,
  );
  assert.ok(approving.length >= 5, 'every channel names an approve');
  for (const family of approving) {
    const texts = [await readFile(join(ROOT, family.contract), 'utf8')];
    for (const entry of await readdir(join(ROOT, 'skills'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(family.prefix)) {
        texts.push(await readFile(join(ROOT, 'skills', entry.name, 'SKILL.md'), 'utf8'));
      }
    }
    const prose = texts.join('\n').replace(/\s+/g, ' ');
    for (const { tool, command } of [
      ...handOffs('waitForApproval', family.channel),
      ...handOffs('revokeApproval', family.channel),
    ]) {
      assert.ok(prose.includes(`\`${tool}\``), `the ${family.family} skills name ${tool}`);
      assert.ok(prose.includes(command), `the ${family.family} skills name \`${command}\``);
    }
  }
});
