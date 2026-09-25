import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { promisify } from 'node:util';
import { PACKAGES } from '../scripts/packages.mjs';
import { checkParity, readTable } from '../scripts/parity.mjs';
import { deriveRegistries, ROOT, SURFACES, scratchEnv, WRAPPERS } from '../scripts/registries.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/**
 * Everything can be done both ways — from a terminal and from a chat — or `capabilities.json` says, in a row, why not
 * yet or why never.
 *
 * `docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md` §7. The command tree and the tool list are read from
 * the product by `scripts/registries.mjs`, the same derivation that generates `docs/reference/`, and the table is
 * checked against both in both directions. Hand-written lists went stale four times in this repository; this one fails
 * the build the moment it does.
 *
 * **Strict mode, and the release.** The table carries `pending` rows: the gaps the design's phases close. They pass
 * here, because this runs on every push while those phases are under way. `PARITY_STRICT=1` — or
 * `pnpm verify:parity --strict`, the same check as a script — also fails on every pending row. The release flips it
 * on: a version shipped with a pending row ships a command nobody can reach from chat, or a tool with no command,
 * which is the defect this design exists to remove.
 */

const STRICT = process.env.PARITY_STRICT === '1';
const exec = promisify(execFile);

let registries;
let table;
before(async () => {
  registries = await deriveRegistries({ env: scratchEnv(await tempDir('agentcomms-parity-')) });
  table = await readTable();
});

/** A readable list for a failed assertion: one problem per line, so the output names every one, not the first. */
const listed = (problems) => `\n  - ${problems.join('\n  - ')}`;

/** Asserts that some problem mentions each fragment — the proof a failure names what is missing. */
function assertNamed(problems, ...fragments) {
  assert.ok(problems.length > 0, 'expected the check to fail, and it passed');
  for (const fragment of fragments) {
    assert.ok(
      problems.some((problem) => problem.includes(fragment)),
      `expected a problem naming ${fragment}; got:${listed(problems)}`,
    );
  }
}

// ── The registries are read, and read right ─────────────────────────────────────────────────────────────────────

test('the derivation reads every surface: its commands, its groups and its tools', () => {
  // Each floor is well under today's count. A pattern that silently matched nothing would pass every check below
  // with an empty registry, so an empty or collapsed read fails here first.
  assert.ok(registries.core.commands.length >= 5, 'the core usage table should be readable');
  assert.ok(registries.gmail.commands.length > 30, 'the agent-gmail command tree should be readable');
  assert.ok(registries.slack.commands.length > 15, 'the agent-slack command tree should be readable');
  assert.ok(registries.gmail.tools.length > 20, 'the Gmail server should list its tools');
  assert.ok(registries.slack.tools.length > 10, 'the Slack server should list its tools');
});

test('groups are told from commands the way the derivation documents', () => {
  // Commander lists its own `help` entry only under a command with subcommands and no action. If that stops being
  // true, this names the cause before the table check reports a wall of symptoms.
  assert.ok(registries.gmail.groups.includes('inbox'), '`agent-gmail inbox` only groups, so it is not a command');
  assert.ok(!registries.gmail.commands.includes('inbox'));
  assert.ok(registries.gmail.commands.includes('inbox add'));
  assert.ok(registries.gmail.commands.includes('mcp'), '`agent-gmail mcp` runs the server, so it is a command');
  assert.ok(registries.gmail.commands.includes('mcp install'), '…and its subcommands are commands too');
  assert.ok(registries.slack.commands.includes('mcp'));
  // The core's usage table: a path with a line of its own acts; a path that only prefixes others groups.
  assert.ok(registries.core.groups.includes('audit'));
  assert.ok(registries.core.commands.includes('audit tail'));
  // Hidden commands are a sign-in's background half, which nobody runs; help leaves them out, and so does this.
  assert.ok(!registries.gmail.commands.includes('oauth-listen'));
  assert.ok(!registries.slack.commands.includes('sign-in-listen'));
});

test('every published package is read, directly or as the package it wraps', async () => {
  const read = new Set(SURFACES.map((surface) => surface.package));
  for (const name of PACKAGES) {
    assert.ok(
      read.has(name) || name in WRAPPERS,
      `@agentcomms/${name} is published, but scripts/registries.mjs neither reads it nor names it as a wrapper — its commands and tools would escape the parity check`,
    );
  }
  for (const [wrapper, wrapped] of Object.entries(WRAPPERS)) {
    assert.ok(read.has(wrapped), `${wrapper} wraps ${wrapped}, which is not read`);
    // A wrapper is only exempt while it has nothing of its own. A tool registered here would be on no list.
    const source = await readFile(join(ROOT, 'packages', wrapper, 'src', 'server.ts'), 'utf8');
    assert.doesNotMatch(source, /registerTool\(/, `${wrapper} registers a tool of its own; read it as a surface`);
  }
});

// ── The table, against the product ──────────────────────────────────────────────────────────────────────────────

test(`capabilities.json names every command and tool, and only ones that exist${STRICT ? ' — strict: nothing pending' : ''}`, () => {
  const problems = checkParity(table, registries, { strict: STRICT });
  assert.deepEqual(problems, [], `capabilities.json and the product disagree:${listed(problems)}`);
});

test('`pnpm verify:parity --strict` exits non-zero exactly while a row is pending', async () => {
  // The release reads this exit code, so a script that printed its problems and exited 0 would be a gate that never
  // shut. Checked against the table as it stands: failing while anything is pending, passing once nothing is.
  const pending = table.capabilities.filter((row) => row.status === 'pending');
  const script = join(ROOT, 'scripts', 'parity.mjs');
  let status = 0;
  let stderr = '';
  try {
    // The flags `pnpm verify:parity` passes, so this runs the script the way the release will.
    await exec(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script, '--strict'],
      { encoding: 'utf8' },
    );
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    status = error.code;
    stderr = String(error.stderr ?? '');
  }
  assert.equal(status, pending.length > 0 ? 1 : 0, stderr);
  for (const row of pending) {
    assert.match(stderr, new RegExp(`row "${row.id.replaceAll('.', '\\.')}" is still pending`));
  }

  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.match(manifest.scripts['verify:parity'], /scripts\/parity\.mjs$/, 'so `--strict` reaches the script');
});

// ── The three mutations: each has to fail, naming what is missing ───────────────────────────────────────────────

/**
 * A `both` row whose command and tool no other row names, so taking it away leaves each uncovered.
 *
 * Chosen from the table rather than named here: a test pinned to one id stopped testing anything the day that row was
 * the one missing, and failed for the wrong reason instead of the right one.
 */
function soleRow(within = table) {
  const rows = within.capabilities;
  const found = rows.find(
    (row) =>
      row.status === 'both' &&
      row.package !== 'core' &&
      rows.filter((other) => other.package === row.package && other.cli === row.cli).length === 1 &&
      rows.filter((other) => other.mcp === row.mcp).length === 1,
  );
  assert.ok(found, 'the table should have a "both" row whose command and tool appear nowhere else');
  return found;
}

test('a row removed: the command and the tool it covered are each named', () => {
  const row = soleRow();
  const mutated = structuredClone(table);
  mutated.capabilities = mutated.capabilities.filter((other) => other.id !== row.id);
  assertNamed(
    checkParity(mutated, registries),
    `\`${registries[row.package].binary} ${row.cli}\` is a command, but no row`,
    `${row.mcp} is an MCP tool, but no row`,
  );
});

test('a tool added with no row: it is named', () => {
  const mutated = structuredClone(registries);
  mutated.slack.tools.push('slack_fake_tool');
  assertNamed(checkParity(table, mutated), 'slack_fake_tool is an MCP tool, but no row');
});

test('a command renamed: the new name has no row, and the row still naming the old one is caught', () => {
  const row = soleRow();
  const binary = registries[row.package].binary;
  const mutated = structuredClone(registries);
  mutated[row.package].commands = mutated[row.package].commands.map((path) =>
    path === row.cli ? `${path}-renamed` : path,
  );
  assertNamed(
    checkParity(table, mutated),
    `\`${binary} ${row.cli}-renamed\` is a command, but no row`,
    `row "${row.id}" names \`${binary} ${row.cli}\`, which does not exist`,
  );
});

// ── Every other rule, each mutation-tested on a table small enough to read ──────────────────────────────────────

/**
 * Registries and a table that agree — including the shapes that are allowed but look odd: one command in two rows
 * (`inbox add` starts and finishes a sign-in), a channel's command served by the core's server, an exception, and a
 * pending row. Every test below breaks exactly one thing, from a baseline shown to pass.
 */
function fixture() {
  return {
    registries: {
      core: { binary: 'agentcomms', commands: ['paths'], groups: [], tools: ['comms_paths', 'comms_server_install'] },
      gmail: {
        binary: 'agent-gmail',
        commands: ['search', 'inbox add', 'approve', 'mcp install'],
        groups: ['inbox', 'mcp'],
        tools: ['gmail_search', 'gmail_inbox_add', 'gmail_inbox_finish'],
      },
      slack: { binary: 'agent-slack', commands: ['search', 'doctor'], groups: [], tools: ['slack_search'] },
    },
    table: {
      capabilities: [
        { id: 'core.paths', package: 'core', cli: 'paths', mcp: 'comms_paths', status: 'both' },
        { id: 'gmail.search', package: 'gmail', cli: 'search', mcp: 'gmail_search', status: 'both' },
        { id: 'gmail.inbox.add', package: 'gmail', cli: 'inbox add', mcp: 'gmail_inbox_add', status: 'both' },
        { id: 'gmail.inbox.finish', package: 'gmail', cli: 'inbox add', mcp: 'gmail_inbox_finish', status: 'both' },
        { id: 'gmail.approve', package: 'gmail', cli: 'approve', mcp: null, status: 'exception', reason: 'a person' },
        { id: 'gmail.mcp.install', package: 'gmail', cli: 'mcp install', mcp: 'comms_server_install', status: 'both' },
        { id: 'slack.search', package: 'slack', cli: 'search', mcp: 'slack_search', status: 'both' },
        { id: 'slack.doctor', package: 'slack', cli: 'doctor', mcp: null, status: 'pending', phase: 'P3' },
      ],
    },
  };
}

/** The fixture with one change, checked. */
function breaking(change, options) {
  const f = fixture();
  const row = (id) => f.table.capabilities.find((r) => r.id === id);
  change({ ...f, row });
  return checkParity(f.table, f.registries, options);
}

test('the fixture passes as it stands, so a failure below is the change and nothing else', () => {
  assert.deepEqual(
    breaking(() => {}),
    [],
  );
});

test('strict mode fails on each pending row, and on nothing else', () => {
  assert.deepEqual(
    breaking(() => {}, { strict: true }),
    [
      'row "slack.doctor" is still pending (P3): `agent-slack doctor` has no MCP tool — a release needs it "both", or an "exception" with its reason',
    ],
  );
});

test('a "both" row missing either side fails', () => {
  assertNamed(
    breaking(({ row }) => {
      row('slack.search').mcp = null;
    }),
    'row "slack.search" is "both" but names no MCP tool',
  );
  assertNamed(
    breaking(({ row }) => {
      row('core.paths').cli = null;
    }),
    'row "core.paths" is "both" but names no CLI command',
  );
});

test('an exception without a reason fails', () => {
  assertNamed(
    breaking(({ row }) => {
      delete row('gmail.approve').reason;
    }),
    'row "gmail.approve" is an exception with no "reason"',
  );
  assertNamed(
    breaking(({ row }) => {
      row('gmail.approve').reason = '  ';
    }),
    'row "gmail.approve" is an exception with no "reason"',
  );
});

test('a pending row without a phase, or with one the design does not have, fails', () => {
  assertNamed(
    breaking(({ row }) => {
      delete row('slack.doctor').phase;
    }),
    'row "slack.doctor" is pending with no "phase"',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.doctor').phase = 'P9';
    }),
    'row "slack.doctor" is pending in phase "P9"',
  );
});

test('a phase left on a row that is no longer pending fails', () => {
  assertNamed(
    breaking(({ row }) => {
      row('slack.search').phase = 'P3';
    }),
    'row "slack.search" is "both" but still carries phase "P3"',
  );
});

test('an exception or pending row naming both sides, or neither, fails', () => {
  assertNamed(
    breaking(({ row }) => {
      row('gmail.approve').mcp = 'gmail_search';
    }),
    'row "gmail.approve" is "exception" but names both sides',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.doctor').cli = null;
    }),
    'row "slack.doctor" is "pending" but names neither',
  );
});

test('a row naming a group, rather than the command under it, fails and says which to name', () => {
  assertNamed(
    breaking(({ row }) => {
      row('gmail.inbox.add').cli = 'inbox';
    }),
    'row "gmail.inbox.add" names `agent-gmail inbox`, which only groups other commands',
  );
});

test('a row naming a tool no server registers fails', () => {
  assertNamed(
    breaking(({ row }) => {
      row('gmail.search').mcp = 'gmail_search_everything';
    }),
    'row "gmail.search" names the MCP tool gmail_search_everything, which no server registers',
  );
});

test("a channel's row may name the core server's tool, but not another channel's", () => {
  assertNamed(
    breaking(({ table }) => {
      table.capabilities.push({
        id: 'gmail.wrong',
        package: 'gmail',
        cli: 'search',
        mcp: 'slack_search',
        status: 'both',
      });
    }),
    'row "gmail.wrong" is a gmail capability, but slack_search is registered by the slack server',
  );
});

test('a tool registered by two servers fails', () => {
  assertNamed(
    breaking(({ registries }) => {
      registries.slack.tools.push('gmail_search');
    }),
    'the MCP tool gmail_search is registered by both gmail and slack',
  );
});

test('a side an exception says has no counterpart may not be paired by another row', () => {
  assertNamed(
    breaking(({ registries, table }) => {
      registries.gmail.tools.push('gmail_approve');
      table.capabilities.push({
        id: 'gmail.approve.chat',
        package: 'gmail',
        cli: 'approve',
        mcp: 'gmail_approve',
        status: 'both',
      });
    }),
    'row "gmail.approve" says `agent-gmail approve` has no counterpart, but row "gmail.approve.chat" names it too',
  );
});

test('a table without its array, a row that is not an object, and a side that is not a name or null each fail', () => {
  assert.deepEqual(checkParity({}, fixture().registries), ['capabilities.json has no "capabilities" array']);
  assertNamed(
    breaking(({ table }) => {
      table.capabilities.push('gmail.search');
    }),
    'row 9 is not an object',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.doctor').mcp = '';
    }),
    'row "slack.doctor": "mcp" must be a tool name, or null',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.doctor').cli = ['doctor'];
    }),
    'row "slack.doctor": "cli" must be a command path, or null',
  );
});

test('a repeated id, a repeated row, an unknown status or field, and an unknown package each fail', () => {
  assertNamed(
    breaking(({ row }) => {
      row('slack.search').id = 'gmail.search';
    }),
    'row "gmail.search" appears twice',
  );
  assertNamed(
    breaking(({ table }) => {
      table.capabilities.push({ ...table.capabilities[1], id: 'gmail.search.again' });
    }),
    'row "gmail.search.again" repeats row "gmail.search"',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.search').status = 'done';
    }),
    'row "slack.search" has status "done"',
  );
  // A misspelt field is the likeliest mistake, and a misspelt `phase` would otherwise read as no phase at all.
  assertNamed(
    breaking(({ row }) => {
      row('slack.doctor').phaes = 'P3';
    }),
    'row "slack.doctor" has an unknown field "phaes"',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.search').package = 'outlook';
    }),
    'row "slack.search" names package "outlook"',
  );
});
