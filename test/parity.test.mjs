import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { promisify } from 'node:util';
import { DRIVERS, driveOperations, resolveOperation } from '../scripts/operations.mjs';
import { PACKAGES } from '../scripts/packages.mjs';
import { checkOperations, checkParity, readTable, uncheckedRows, verifyParity } from '../scripts/parity.mjs';
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
 * **Strict mode.** While the design's phases were under way the table carried `pending` rows, and this test let them
 * pass. They are closed, so `pnpm verify` now also runs `pnpm verify:parity --strict`, which fails on any pending
 * row: a command nobody can reach from chat, or a tool with no command, is the defect this design exists to remove,
 * and it no longer merges. `PARITY_STRICT=1` makes this test strict too.
 *
 * **One operation.** Names were not enough: a reviewer swapped `gmail.search` with `gmail.trash`, and `slack.post.send`
 * with `slack.read`, and every check here still passed, because both sides of every row still existed. So each `both`
 * row now names the operation its command and its tool run, and `scripts/operations.mjs` runs both — every operation
 * replaced by a stand-in that records the call and does nothing, in a sealed process — to see that each reaches it
 * before any operation another row names. The swap is the first thing tested below, against the table as committed.
 */

const STRICT = process.env.PARITY_STRICT === '1';
const exec = promisify(execFile);

let registries;
let table;
/** The committed table, driven once: what each row's command and tool reached. */
let driven;
before(async () => {
  table = await readTable();
  [registries, driven] = await Promise.all([
    deriveRegistries({ env: scratchEnv(await tempDir('agentcomms-parity-')) }),
    driveOperations(table, { dir: await tempDir('agentcomms-parity-drive-') }),
  ]);
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

// ── One operation: what each row's command and tool actually run ────────────────────────────────────────────────

test("every row's command and tool reach the operation it names, before any other row's", () => {
  const problems = checkOperations(table, registries, driven);
  assert.deepEqual(problems, [], `a row's two sides do not run its operation:${listed(problems)}`);
});

test('every "both" row was run on both sides, unless it says in "unchecked" why not', () => {
  // A row the drive skipped would pass by saying nothing. Each one it did not skip reached something.
  assert.equal(driven.fatal, undefined, driven.fatal);
  for (const row of table.capabilities.filter((r) => r.status === 'both')) {
    if (row.unchecked !== undefined) {
      assert.ok(!driven.reports[row.id], `row "${row.id}" is unchecked, so it is not run`);
      continue;
    }
    for (const side of ['cli', 'mcp']) {
      assert.ok(driven.reports[row.id]?.[side]?.calls.length > 0, `row "${row.id}": the ${side} side reached nothing`);
    }
  }
  // Unchecked rows are few, named, and printed on every run: a way out that stays in view.
  assert.ok(uncheckedRows(table).length <= 5, 'a table of mostly unchecked rows checks nothing');
});

test('every package with a surface has a driver, so none of its rows goes unrun', () => {
  for (const surface of SURFACES) {
    assert.ok(DRIVERS[surface.package], `scripts/operations.mjs has no driver for ${surface.package}`);
  }
});

/** `table` with two rows' tools exchanged — and each tool's arguments with it — the way the reviewer probed it. */
function swapTools(source, a, b) {
  const mutated = structuredClone(source);
  const first = mutated.capabilities.find((row) => row.id === a);
  const second = mutated.capabilities.find((row) => row.id === b);
  [first.mcp, second.mcp] = [second.mcp, first.mcp];
  const [argsA, argsB] = [first.args, second.args];
  delete first.args;
  delete second.args;
  if (argsB !== undefined) first.args = argsB;
  if (argsA !== undefined) second.args = argsA;
  return mutated;
}

test('the reviewer’s swap — gmail.search ↔ gmail.trash, slack.post.send ↔ slack.read — fails strict mode', async () => {
  const mutated = swapTools(swapTools(table, 'gmail.search', 'gmail.trash'), 'slack.post.send', 'slack.read');
  // The gap: every name still exists, so the name check alone passes the swap. It did, until this rule.
  assert.deepEqual(checkParity(mutated, registries, { strict: true }), []);
  const problems = await verifyParity({
    table: mutated,
    registries,
    strict: true,
    dir: await tempDir('agentcomms-parity-swap-'),
  });
  assertNamed(
    problems,
    'row "gmail.search": gmail_trash {"inbox":"parity/gmail"} reaches trash — the operation of row "gmail.trash" — before search',
    'row "gmail.trash": gmail_search {"query":"parity"} reaches search — the operation of row "gmail.search" — before trash',
    'row "slack.post.send": slack_read',
    'reaches readChannel — the operation of row "slack.read" — before sendPost',
    'row "slack.read": slack_post_send',
    'reaches sendPost — the operation of row "slack.post.send" — before readChannel',
  );
  assert.equal(problems.length, 4, listed(problems));
});

test('a wrong operation, one that does not exist, a new row pairing two operations, none, and a helper named as one all fail', async () => {
  const mutated = structuredClone(table);
  const row = (id) => mutated.capabilities.find((r) => r.id === id);
  // Another row's operation, which neither side runs.
  row('gmail.labels.list').operation = 'trash';
  // A name no operations module exports.
  row('gmail.whoami').operation = 'whoAmI';
  // A new row pairing a command with a tool that runs something else.
  mutated.capabilities.push({
    id: 'gmail.contacts.wrong',
    package: 'gmail',
    cli: 'contacts',
    mcp: 'gmail_followups',
    status: 'both',
    operation: 'searchContacts',
  });
  // No operation at all: the check says what both sides reach, so the fix is one line.
  delete row('gmail.export').operation;
  // A helper every Slack tool calls on its way, named as a row's operation to make that row pass.
  delete row('slack.draft.list').unchecked;
  row('slack.draft.list').operation = 'requireWorkspace';

  const problems = await verifyParity({ table: mutated, registries, dir: await tempDir('agentcomms-parity-wrong-') });
  assertNamed(
    problems,
    'row "gmail.labels.list": `agent-gmail labels --inbox parity/gmail --json` never reaches trash',
    'row "gmail.labels.list": gmail_labels_list {"inbox":"parity/gmail"} never reaches trash',
    'it reaches listLabels',
    'row "gmail.whoami" names the operation "whoAmI", but no module in packages/gmail/src/operations or the core\'s exports a function called "whoAmI"',
    'row "gmail.contacts.wrong": gmail_followups {} reaches followUps — the operation of row "gmail.followups" — before searchContacts',
    'row "gmail.export" is "both" but names no "operation"',
    'row "gmail.export": its command and its tool both reach exportMail — name the one that does the work as its "operation"',
    // The helper is now a row's operation, so every Slack row whose side reaches it first fails — loudly, and many.
    'row "slack.read": slack_read',
    'reaches requireWorkspace — the operation of row "slack.draft.list" — before readChannel',
  );
  // The command side of the contacts row is right; only its tool is wrong.
  assert.ok(!problems.some((problem) => problem.startsWith('row "gmail.contacts.wrong": `')), listed(problems));
  assert.ok(
    problems.filter((problem) => problem.includes('the operation of row "slack.draft.list"')).length > 10,
    'naming a helper every Slack tool calls should fail every row that reaches it first',
  );
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
        { id: 'core.paths', package: 'core', cli: 'paths', mcp: 'comms_paths', status: 'both', operation: 'corePaths' },
        {
          id: 'gmail.search',
          package: 'gmail',
          cli: 'search',
          mcp: 'gmail_search',
          status: 'both',
          operation: 'search',
        },
        {
          id: 'gmail.inbox.add',
          package: 'gmail',
          cli: 'inbox add',
          mcp: 'gmail_inbox_add',
          status: 'both',
          operation: 'startSignIn',
          argv: ['work'],
        },
        {
          id: 'gmail.inbox.finish',
          package: 'gmail',
          cli: 'inbox add',
          mcp: 'gmail_inbox_finish',
          status: 'both',
          operation: 'finishSignIn',
          argv: ['--finish', 'flow'],
          args: { flowId: 'flow' },
        },
        { id: 'gmail.approve', package: 'gmail', cli: 'approve', mcp: null, status: 'exception', reason: 'a person' },
        {
          id: 'gmail.mcp.install',
          package: 'gmail',
          cli: 'mcp install',
          mcp: 'comms_server_install',
          status: 'both',
          operation: 'serverInstallChange',
        },
        {
          id: 'slack.search',
          package: 'slack',
          cli: 'search',
          mcp: 'slack_search',
          status: 'both',
          unchecked: 'the fixture’s one row that is not checked',
        },
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

// ── The operation rules, each mutation-tested on the fixture ────────────────────────────────────────────────────

test('a "both" row names its operation, or says in "unchecked" why it is not checked — one or the other', () => {
  assertNamed(
    breaking(({ row }) => {
      delete row('gmail.search').operation;
    }),
    'row "gmail.search" is "both" but names no "operation": the function of packages/gmail/src/operations',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.search').operation = 'searchMessages';
    }),
    'row "slack.search" names an "operation" and says it is "unchecked"; it is one or the other',
  );
  assertNamed(
    breaking(({ row }) => {
      row('slack.search').unchecked = ' ';
    }),
    'row "slack.search" has an empty "unchecked"',
  );
});

test('an operation is a name or a list of distinct names; argv is words, args an object', () => {
  for (const operation of ['', [], ['search', 'search'], [3], 3]) {
    assertNamed(
      breaking(({ row }) => {
        row('gmail.search').operation = operation;
      }),
      'row "gmail.search": "operation" must name a function exported from packages/gmail/src/operations',
    );
  }
  assert.deepEqual(
    breaking(({ row }) => {
      row('gmail.search').operation = ['search', 'readMessage'];
    }),
    [],
    'a composite command names several',
  );
  assertNamed(
    breaking(({ row }) => {
      row('gmail.inbox.add').argv = 'work';
    }),
    'row "gmail.inbox.add": "argv" must be a list of the words to add to the command',
  );
  assertNamed(
    breaking(({ row }) => {
      row('gmail.inbox.finish').args = ['flow'];
    }),
    'row "gmail.inbox.finish": "args" must be an object of arguments for the tool',
  );
  assertNamed(
    breaking(({ row }) => {
      delete row('gmail.inbox.add').operation;
      row('gmail.inbox.add').unchecked = 'why';
      row('gmail.inbox.add').via = 'setupState';
    }),
    'row "gmail.inbox.add" has "via" but no "operation"',
  );
});

test('only a "both" row carries what its two sides run', () => {
  for (const key of ['operation', 'via', 'argv', 'args', 'unchecked']) {
    assertNamed(
      breaking(({ row }) => {
        row('gmail.approve')[key] = key === 'argv' ? ['x'] : key === 'args' ? {} : 'x';
      }),
      `row "gmail.approve" is "exception" but carries "${key}"`,
    );
  }
  assertNamed(
    breaking(({ row }) => {
      row('slack.doctor').operation = 'runDoctor';
    }),
    'row "slack.doctor" is "pending" but carries "operation"',
  );
});

/** Every function the fixture's operations modules export, as the drive reports them. */
const FIXTURE_OPERATIONS = {
  core: { corePaths: ['operations/maintenance.ts'], serverInstallChange: ['operations/servers.ts'], doctor: ['x.ts'] },
  gmail: {
    search: ['operations/search.ts'],
    readMessage: ['operations/read.ts'],
    startSignIn: ['operations/signin.ts'],
    finishSignIn: ['operations/signin.ts'],
    checkedPort: ['operations/signin.ts'],
    setupState: ['operations/setup.ts'],
    doctor: ['operations/doctor.ts'],
    twice: ['operations/a.ts', 'operations/b.ts'],
  },
  slack: {},
};

/** What a correct drive of the fixture saw: each side reaching its row's operation, on the way it really goes. */
function drivenFixture() {
  const side = (calls, extra = {}) => ({ calls, stopped: calls.at(-1), timedOut: false, refusal: null, ...extra });
  return {
    operations: structuredClone(FIXTURE_OPERATIONS),
    reports: {
      'core.paths': { cli: side(['core:corePaths'], { argv: ['paths'] }), mcp: side(['core:corePaths'], { args: {} }) },
      'gmail.search': {
        cli: side(['gmail:search'], { argv: ['search', 'x'] }),
        mcp: side(['gmail:search'], { args: { query: 'x' } }),
      },
      'gmail.inbox.add': {
        // A helper no row names, on the way: allowed, and shown in what the side reached.
        cli: side(['gmail:checkedPort', 'gmail:startSignIn'], { argv: ['inbox', 'add', 'work'] }),
        mcp: side(['gmail:startSignIn'], { args: { alias: 'work' } }),
      },
      'gmail.inbox.finish': {
        cli: side(['gmail:checkedPort', 'gmail:finishSignIn'], { argv: ['inbox', 'add', '--finish', 'flow'] }),
        mcp: side(['gmail:finishSignIn'], { args: { flowId: 'flow' } }),
      },
      'gmail.mcp.install': {
        cli: side(['core:serverInstallChange'], { argv: ['mcp', 'install'] }),
        mcp: side(['core:serverInstallChange'], { args: {} }),
      },
    },
  };
}

/** The fixture with one change to the table or to what the drive saw, checked for operations. */
function reaching(change) {
  const f = { ...fixture(), driven: drivenFixture() };
  const row = (id) => f.table.capabilities.find((r) => r.id === id);
  change({ ...f, row });
  return checkOperations(f.table, f.registries, f.driven);
}

test('the operation fixture passes as it stands, including a channel row running the core’s operation', () => {
  assert.deepEqual(
    reaching(() => {}),
    [],
  );
});

test('a side that never reaches the operation fails, saying what it reached and how it ended', () => {
  assertNamed(
    reaching(({ driven }) => {
      driven.reports['gmail.search'].mcp = {
        args: { query: 'x' },
        calls: ['gmail:readMessage'],
        stopped: null,
        timedOut: false,
        refusal: 'USAGE: something',
      };
    }),
    'row "gmail.search": gmail_search {"query":"x"} never reaches search (gmail\'s operations/search.ts); it reaches readMessage, and ends: USAGE: something',
  );
  assertNamed(
    reaching(({ driven }) => {
      driven.reports['gmail.search'].cli = { argv: ['search'], calls: [], stopped: null, timedOut: true };
    }),
    'row "gmail.search": `agent-gmail search` never reaches search (gmail\'s operations/search.ts); it reaches no operation at all, and did not finish',
  );
});

test('reaching another row’s operation first fails the row, naming whose it is', () => {
  assertNamed(
    reaching(({ driven }) => {
      driven.reports['gmail.inbox.add'].cli.calls = ['gmail:finishSignIn', 'gmail:startSignIn'];
    }),
    'row "gmail.inbox.add": `agent-gmail inbox add work` reaches finishSignIn — the operation of row "gmail.inbox.finish" — before startSignIn',
  );
});

test('"via" lets a side pass through another row’s operation, and only another row’s', () => {
  const passingThrough = ({ table, driven }) => {
    table.capabilities.push({
      id: 'gmail.setup',
      package: 'gmail',
      cli: 'search',
      mcp: 'gmail_search',
      status: 'both',
      operation: 'setupState',
    });
    driven.reports['gmail.setup'] = {
      cli: { argv: ['search'], calls: ['gmail:setupState'] },
      mcp: { args: {}, calls: ['gmail:setupState'] },
    };
    driven.reports['gmail.inbox.add'].cli.calls = ['gmail:setupState', 'gmail:startSignIn'];
  };
  assertNamed(
    reaching(passingThrough),
    'row "gmail.inbox.add": `agent-gmail inbox add work` reaches setupState — the operation of row "gmail.setup" — before startSignIn',
  );
  assert.deepEqual(
    reaching((f) => {
      passingThrough(f);
      f.row('gmail.inbox.add').via = 'setupState';
    }),
    [],
  );
  // A "via" no other row names stops nothing: it is only a name for a reader to wonder about.
  assertNamed(
    reaching(({ row }) => {
      row('gmail.inbox.add').via = 'checkedPort';
    }),
    'row "gmail.inbox.add" lists "checkedPort" under "via", but no other row names it; take it out',
  );
  assertNamed(
    reaching(({ row }) => {
      row('gmail.inbox.add').via = 'nothing';
    }),
    'row "gmail.inbox.add" lists "nothing" under "via", but no module in packages/gmail/src/operations or the core\'s exports a function called "nothing"',
  );
});

test('an operation is looked up in the row’s package, then the core’s — never the other way — and must be one function', () => {
  assertNamed(
    reaching(({ row }) => {
      row('gmail.search').operation = 'nothing';
    }),
    'row "gmail.search" names the operation "nothing", but no module in packages/gmail/src/operations or the core\'s exports a function called "nothing"',
  );
  assertNamed(
    reaching(({ row }) => {
      row('gmail.search').operation = 'twice';
    }),
    'row "gmail.search" names the operation "twice", but "twice" is exported by more than one module of gmail: operations/a.ts, operations/b.ts',
  );
  // `doctor` in a Gmail row is Gmail's; in a core row, the core's — and a core row never reaches into a channel.
  assert.equal(resolveOperation(FIXTURE_OPERATIONS, 'gmail', 'doctor').id, 'gmail:doctor');
  assert.equal(resolveOperation(FIXTURE_OPERATIONS, 'gmail', 'serverInstallChange').id, 'core:serverInstallChange');
  assert.equal(resolveOperation(FIXTURE_OPERATIONS, 'core', 'doctor').id, 'core:doctor');
  assert.match(resolveOperation(FIXTURE_OPERATIONS, 'core', 'search').problem, /packages\/core\/src\/operations/);
});

test('a composite command reaches every operation it names', () => {
  assertNamed(
    reaching(({ row }) => {
      row('gmail.search').operation = ['search', 'readMessage'];
    }),
    'row "gmail.search": `agent-gmail search x` never reaches readMessage (gmail\'s operations/read.ts); it reaches search',
    'row "gmail.search": gmail_search {"query":"x"} never reaches readMessage',
  );
});

test('a row that was not run fails, unless the name check already says its side does not exist, or the drive hung', () => {
  assertNamed(
    reaching(({ driven }) => {
      delete driven.reports['gmail.search'];
    }),
    'row "gmail.search": `agent-gmail search` was not run',
    'row "gmail.search": gmail_search {} was not run',
  );
  assert.deepEqual(
    reaching(({ registries, driven }) => {
      registries.gmail.tools = registries.gmail.tools.filter((tool) => tool !== 'gmail_search');
      delete driven.reports['gmail.search'].mcp;
    }),
    [],
    'a tool no server registers is reported by checkParity, once',
  );
  assert.deepEqual(
    reaching(({ driven }) => {
      driven.fatal = 'row "gmail.search" did not finish';
      delete driven.reports['gmail.inbox.add'];
    }),
    ['the operations drive stopped early: row "gmail.search" did not finish'],
  );
});

test('an unchecked row is not judged, and a row naming no operation is told what both of its sides reach', () => {
  assert.deepEqual(
    reaching(({ driven }) => {
      driven.reports['slack.search'] = { cli: { calls: [] }, mcp: { calls: [] } };
    }),
    [],
  );
  assertNamed(
    reaching(({ row, driven }) => {
      delete row('gmail.search').operation;
      driven.reports['gmail.search'].cli.calls = ['gmail:checkedPort', 'gmail:search'];
    }),
    'row "gmail.search": its command and its tool both reach search — name the one that does the work',
  );
  assertNamed(
    reaching(({ row, driven }) => {
      delete row('gmail.search').operation;
      driven.reports['gmail.search'].mcp.calls = ['gmail:readMessage'];
    }),
    'row "gmail.search": its command and its tool reach no operation in common — the command reaches search; the tool, readMessage',
  );
});
