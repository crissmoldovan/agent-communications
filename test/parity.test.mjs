import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DRIVERS, driveOperations, parameterNames, recordArguments, resolveOperation } from '../scripts/operations.mjs';
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
 *
 * **Rows that share an operation.** Reaching an operation cannot tell apart rows that run the same one: four Slack rows
 * run `planModeSet`, and a second review swapped the tools of `slack.mode.report` and `slack.mode.narrow`, of
 * `slack.mode.request-send` and `slack.mode.narrow`, and of `slack.react` and `slack.react.send`, and strict mode still
 * passed. So the drive records what the row's operation receives, and such rows say in `expect` which arguments tell
 * them apart; those swaps are tested below too.
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

test('the second review’s swaps — between rows that share an operation — each fail strict mode', {
  concurrency: true,
}, async (t) => {
  /**
   * Each swap reaches the right operation on every side, so everything above passed it. Only what the operation
   * receives tells these rows apart — the mode asked for, whether an approval is claimed, the channel installed — and
   * each fails on both rows, naming the value the moved side brought with it. Run side by side: each is a drive.
   */
  const probe = (name, mutate, ...fragments) =>
    t.test(name, async () => {
      const mutated = mutate(structuredClone(table));
      assert.deepEqual(checkParity(mutated, registries, { strict: true }), [], 'every name still exists');
      const problems = await verifyParity({
        table: mutated,
        registries,
        strict: true,
        dir: await tempDir('agentcomms-parity-shared-'),
      });
      assertNamed(problems, ...fragments);
      assert.equal(problems.length, 2, listed(problems));
    });
  const argsSwapped = (source, a, b) => {
    const [first, second] = [a, b].map((id) => source.capabilities.find((row) => row.id === id));
    [first.args, second.args] = [second.args, first.args];
    return source;
  };
  await Promise.all([
    probe(
      'slack.mode.report ↔ slack.mode.narrow',
      (source) => swapTools(source, 'slack.mode.report', 'slack.mode.narrow'),
      'row "slack.mode.report": slack_mode_narrow {"workspace":"parity/slack"} reaches planModeSet with wanted "read", where the row expects not given',
      'row "slack.mode.narrow": slack_mode {"workspace":"parity/slack"} reaches planModeSet with wanted not given, where the row expects "read"',
    ),
    probe(
      'slack.mode.request-send ↔ slack.mode.narrow',
      (source) => swapTools(source, 'slack.mode.request-send', 'slack.mode.narrow'),
      'row "slack.mode.request-send": slack_mode_narrow {"workspace":"parity/slack"} reaches planModeSet with wanted "read", where the row expects "send"',
      'row "slack.mode.narrow": slack_mode_request_send {"workspace":"parity/slack"} reaches planModeSet with wanted "send", where the row expects "read"',
    ),
    probe(
      'slack.react ↔ slack.react.send',
      (source) => swapTools(source, 'slack.react', 'slack.react.send'),
      'row "slack.react": slack_react_send',
      'reaches react with approvalId "ap_00000000000000000000000000", where the row expects not given',
      'row "slack.react.send": slack_react',
      'reaches react with approvalId not given, where the row expects "ap_00000000000000000000000000"',
    ),
    // One tool behind three commands: what the tool is given decides which, so it is the arguments that move.
    probe(
      'core.mcp.install ↔ slack.mcp.install, by their arguments',
      (source) => argsSwapped(source, 'core.mcp.install', 'slack.mcp.install'),
      'row "core.mcp.install": comms_server_install',
      'reaches serverInstallChange with request.channel "slack", where the row expects "core"',
      'row "slack.mcp.install": comms_server_install',
      'reaches serverInstallChange with request.channel "core", where the row expects "slack"',
    ),
  ]);
});

test('each mode row’s command asks for its mode, as its tool does', () => {
  // Their `argv` once omitted the workspace, so Commander read `send` and `read` as its name and every one of them
  // ran the report. Nothing looked at what `planModeSet` was asked, so nothing noticed.
  for (const [id, mode] of [
    ['slack.mode.report', undefined],
    ['slack.mode.request-send', 'send'],
    ['slack.mode.narrow', 'read'],
    ['slack.mode.set', 'send'],
  ]) {
    for (const side of ['cli', 'mcp']) {
      const received = driven.reports[id][side].received['slack:planModeSet'];
      assert.equal(received.wanted, mode, `row "${id}": the ${side} side asks for ${received.wanted}`);
      assert.equal(received.alias, 'parity/slack', `row "${id}": the ${side} side names the workspace`);
    }
  }
});

test('the sealed drive refuses every way out it knows, and answers the home directory with its own', async () => {
  // The drive's own seal, in a process of its own: each attempt is made after it, as a stand-in that failed would.
  const home = await tempDir('agentcomms-parity-seal-');
  const source = `
    import { seal } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'operations.mjs')).href)};
    import { createRequire } from 'node:module';
    await seal();
    const require = createRequire(import.meta.url);
    const outcomes = {};
    const attempt = async (name, body) => {
      try { await body(); outcomes[name] = 'open'; } catch (error) { outcomes[name] = String(error?.message ?? error); }
    };
    await attempt('fetch', () => fetch('http://127.0.0.1:9'));
    await attempt('net.connect', async () => (await import('node:net')).connect(9, '127.0.0.1'));
    await attempt('Socket.connect', async () => new (await import('node:net')).Socket().connect(9, '127.0.0.1'));
    await attempt('tls.connect', async () => (await import('node:tls')).connect(9, '127.0.0.1'));
    await attempt('http.request', async () => (await import('node:http')).request('http://127.0.0.1:9'));
    await attempt('https.get', async () => (await import('node:https')).get('https://127.0.0.1:9'));
    await attempt('listen', async () => (await import('node:http')).createServer().listen(0));
    await attempt('execFile', async () => (await import('node:child_process')).execFile('/usr/bin/true'));
    await attempt('spawnSync by require', async () => require('node:child_process').spawnSync('/usr/bin/true'));
    await attempt('dgram.createSocket', async () => (await import('node:dgram')).createSocket('udp4'));
    await attempt('dgram by require', async () => require('node:dgram').createSocket('udp4'));
    await attempt('dns.lookup', async () => {
      const { lookup } = await import('node:dns');
      await new Promise((settle, fail) => lookup('localhost', (error) => (error ? fail(error) : settle())));
    });
    await attempt('dns.promises.resolve4', async () => (await import('node:dns/promises')).resolve4('localhost'));
    await attempt('Resolver.resolve', async () => new (await import('node:dns')).Resolver().resolve('localhost', () => {}));
    await attempt('promises Resolver.resolve', async () => new (await import('node:dns')).promises.Resolver().resolve('localhost'));
    await attempt('Worker', async () => new (await import('node:worker_threads')).Worker('0', { eval: true }));
    const os = await import('node:os');
    outcomes.homedir = os.homedir();
    outcomes.userInfoHomedir = os.userInfo().homedir;
    outcomes.userInfoBuffer = os.userInfo({ encoding: 'buffer' }).homedir.toString();
    process.stdout.write(JSON.stringify(outcomes));
    process.exit(0);
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
  const { homedir, userInfoHomedir, userInfoBuffer, ...attempts } = JSON.parse(stdout);
  assert.ok(Object.keys(attempts).length >= 16, 'every attempt reported');
  for (const [name, outcome] of Object.entries(attempts)) {
    assert.match(outcome, /^the parity drive does not /, `${name} was not refused: ${outcome}`);
  }
  assert.equal(homedir, home);
  assert.equal(userInfoHomedir, home, 'os.userInfo() reads the account database, so it would name the real home');
  assert.equal(userInfoBuffer, home);
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
  for (const key of ['operation', 'via', 'argv', 'args', 'expect', 'unchecked']) {
    assertNamed(
      breaking(({ row }) => {
        row('gmail.approve')[key] = key === 'argv' ? ['x'] : key === 'args' || key === 'expect' ? {} : 'x';
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

// ── Rows that share an operation, each rule mutation-tested on the fixture ──────────────────────────────────────

test('an "expect" is an object of argument values, by parameter name, on a row with one operation', () => {
  assert.deepEqual(
    breaking(({ row }) => {
      row('gmail.search').expect = { query: 'x', 'options.limit': 3, 'options.all': false, since: null, ids: ['a'] };
    }),
    [],
    'names, paths into a parameter, and every kind of value the drive records',
  );
  for (const expect of [{}, [], 'x', null, 3]) {
    assertNamed(
      breaking(({ row }) => {
        row('gmail.search').expect = expect;
      }),
      'row "gmail.search": "expect" must be an object of what its operation receives, by parameter name',
    );
  }
  assertNamed(
    breaking(({ row }) => {
      row('gmail.search').expect = { 'options..limit': 3 };
    }),
    'row "gmail.search": "expect" names "options..limit", which is not a parameter\'s name or a path into one',
  );
  for (const value of [{ nested: true }, [{}], Number.NaN]) {
    assertNamed(
      breaking(({ row }) => {
        row('gmail.search').expect = { query: value };
      }),
      'row "gmail.search": "expect" gives "query" a value that is not a string, a number, true or false, a list of those, or null',
    );
  }
  assertNamed(
    breaking(({ row }) => {
      row('gmail.search').operation = ['search', 'readMessage'];
      row('gmail.search').expect = { query: 'x' };
    }),
    'row "gmail.search" names several operations and has "expect"; "expect" is what one operation receives, so it needs one',
  );
  assertNamed(
    breaking(({ row }) => {
      delete row('gmail.search').operation;
      row('gmail.search').unchecked = 'why';
      row('gmail.search').expect = { query: 'x' };
    }),
    'row "gmail.search" has "expect" but no "operation"',
  );
});

/**
 * The operation fixture with a second row running `startSignIn`, through another command and another tool — as four
 * Slack rows run `planModeSet` — and what each side of both rows passed it. `expect` is left to each test.
 */
function sharingFixture() {
  const f = { ...fixture(), driven: drivenFixture() };
  f.registries.gmail.commands.push('inbox reauth');
  f.registries.gmail.tools.push('gmail_inbox_reauth');
  f.table.capabilities.push({
    id: 'gmail.inbox.reauth',
    package: 'gmail',
    cli: 'inbox reauth',
    mcp: 'gmail_inbox_reauth',
    status: 'both',
    operation: 'startSignIn',
    argv: ['work'],
    args: { inbox: 'work' },
  });
  const side = (received, extra) => ({
    calls: ['gmail:startSignIn'],
    received: { 'gmail:startSignIn': received },
    ...extra,
  });
  // Every command waits for the browser and no tool does: that is how the surfaces differ, not how the rows do.
  f.driven.reports['gmail.inbox.add'] = {
    cli: side(
      { 'options.mode': 'add', 'options.alias': 'work', 'options.detached': false },
      { argv: ['inbox', 'add', 'work'] },
    ),
    mcp: side(
      { 'options.mode': 'add', 'options.alias': 'work', 'options.detached': true },
      { args: { alias: 'work' } },
    ),
  };
  f.driven.reports['gmail.inbox.reauth'] = {
    cli: side(
      { 'options.mode': 'reauth', 'options.alias': 'work', 'options.detached': false },
      { argv: ['inbox', 'reauth', 'work'] },
    ),
    mcp: side(
      { 'options.mode': 'reauth', 'options.alias': 'work', 'options.detached': true },
      { args: { inbox: 'work' } },
    ),
  };
  f.driven.parameters = { 'gmail:startSignIn': ['context', 'options'] };
  return f;
}

/** The sharing fixture with one change, checked for operations. */
function sharing(change) {
  const f = sharingFixture();
  const row = (id) => f.table.capabilities.find((r) => r.id === id);
  change({ ...f, row });
  return checkOperations(f.table, f.registries, f.driven);
}

/** Both sharing rows saying what tells them apart. */
const toldApart = ({ row }) => {
  row('gmail.inbox.add').expect = { 'options.mode': 'add' };
  row('gmail.inbox.reauth').expect = { 'options.mode': 'reauth' };
};

test('rows sharing an operation through another command and another tool each say in "expect" what tells them apart', () => {
  assert.deepEqual(sharing(toldApart), []);
  const problems = sharing(() => {});
  assert.deepEqual(
    problems,
    [
      'row "gmail.inbox.add" runs startSignIn, as row "gmail.inbox.reauth" does, through another command and another tool, and has no "expect" to say which it is: both of its sides pass options.mode "add", and theirs do not — "expect": {"options.mode":"add"}',
      'row "gmail.inbox.reauth" runs startSignIn, as row "gmail.inbox.add" does, through another command and another tool, and has no "expect" to say which it is: both of its sides pass options.mode "reauth", and theirs do not — "expect": {"options.mode":"reauth"}',
    ],
    'each is told what to write, from what its two sides were seen to pass',
  );
  // One row saying it is not enough: the other could still be swapped for anything that runs startSignIn.
  assertNamed(
    sharing(({ row }) => {
      row('gmail.inbox.add').expect = { 'options.mode': 'add' };
    }),
    'row "gmail.inbox.reauth" runs startSignIn, as row "gmail.inbox.add" does',
  );
});

test('expecting the same of two rows that share an operation does not tell them apart', () => {
  assertNamed(
    sharing(({ row, driven }) => {
      row('gmail.inbox.add').expect = { 'options.alias': 'work' };
      row('gmail.inbox.reauth').expect = { 'options.alias': 'work', 'options.detached': null };
      // Made true of the tool as well, so the only problem left is the one this test is about.
      driven.reports['gmail.inbox.reauth'].cli.received['gmail:startSignIn']['options.detached'] = null;
      delete driven.reports['gmail.inbox.reauth'].mcp.received['gmail:startSignIn']['options.detached'];
    }),
    'rows "gmail.inbox.add" and "gmail.inbox.reauth" both run startSignIn, through another command and another tool, and their "expect" does not tell them apart',
  );
});

test('a side whose operation receives other than the row expects fails, saying what it received; null is not given', () => {
  assert.deepEqual(
    sharing(({ row, driven }) => {
      toldApart({ row });
      row('gmail.inbox.add').expect['options.email'] = null;
      driven.reports['gmail.inbox.add'].mcp.received['gmail:startSignIn']['options.email'] = null;
    }),
    [],
    'null expects an argument not given, whether it is absent or null',
  );
  // The reviewer's swap, in the fixture: each tool brings its own mode to the other row.
  assert.deepEqual(
    sharing((f) => {
      toldApart(f);
      [f.row('gmail.inbox.add').mcp, f.row('gmail.inbox.reauth').mcp] = ['gmail_inbox_reauth', 'gmail_inbox_add'];
      const [add, reauth] = [f.driven.reports['gmail.inbox.add'], f.driven.reports['gmail.inbox.reauth']];
      [add.mcp, reauth.mcp] = [reauth.mcp, add.mcp];
    }),
    [
      'row "gmail.inbox.add": gmail_inbox_reauth {"inbox":"work"} reaches startSignIn with options.mode "reauth", where the row expects "add"',
      'row "gmail.inbox.reauth": gmail_inbox_add {"alias":"work"} reaches startSignIn with options.mode "add", where the row expects "reauth"',
    ],
  );
  assertNamed(
    sharing(({ row, driven }) => {
      toldApart({ row });
      delete driven.reports['gmail.inbox.add'].cli.received['gmail:startSignIn']['options.mode'];
    }),
    'row "gmail.inbox.add": `agent-gmail inbox add work` reaches startSignIn with options.mode not given, where the row expects "add"',
  );
});

test('an "expect" naming a parameter the operation does not have fails, naming the ones it does', () => {
  assertNamed(
    sharing(({ row }) => {
      toldApart({ row });
      row('gmail.inbox.add').expect = { 'opts.mode': 'add' };
    }),
    'row "gmail.inbox.add" expects "opts.mode", but startSignIn has no parameter "opts"; it takes context, options',
  );
});

test('rows sharing a whole side — the same tool with the same arguments — need no "expect" between them', () => {
  // `gmail_inbox_finish` finishes both kinds of sign-in; `inbox add --finish` and `inbox reauth --finish` one each.
  // Exchanging their commands files each pairing under the other id, and pairs nothing new.
  assert.deepEqual(
    sharing(({ row, driven }) => {
      row('gmail.inbox.reauth').mcp = 'gmail_inbox_add';
      delete row('gmail.inbox.reauth').args;
      driven.reports['gmail.inbox.reauth'].mcp = structuredClone(driven.reports['gmail.inbox.add'].mcp);
    }),
    [],
  );
  // …and the same command with the same words, as `workspace mode <name> send` is behind two Slack rows.
  assert.deepEqual(
    sharing(({ row, driven }) => {
      Object.assign(row('gmail.inbox.reauth'), { cli: 'inbox add' });
      driven.reports['gmail.inbox.reauth'].cli = structuredClone(driven.reports['gmail.inbox.add'].cli);
    }),
    [],
  );
  // An `expect` a row does give is still checked on both sides, shared or not.
  assertNamed(
    sharing(({ row, driven }) => {
      row('gmail.inbox.reauth').mcp = 'gmail_inbox_add';
      delete row('gmail.inbox.reauth').args;
      driven.reports['gmail.inbox.reauth'].mcp = structuredClone(driven.reports['gmail.inbox.add'].mcp);
      row('gmail.inbox.reauth').expect = { 'options.mode': 'reauth' };
    }),
    'row "gmail.inbox.reauth": gmail_inbox_add {"alias":"work"} reaches startSignIn with options.mode "add", where the row expects "reauth"',
  );
});

test('where nothing both sides of a row pass tells it apart, the check says where its command and its tool differ', () => {
  // A command that finishes one kind of sign-in and a tool that finishes either: a real difference, reported as one.
  assertNamed(
    sharing(({ driven }) => {
      delete driven.reports['gmail.inbox.reauth'].mcp.received['gmail:startSignIn']['options.mode'];
    }),
    'row "gmail.inbox.reauth" runs startSignIn, as row "gmail.inbox.add" does, through another command and another tool, and has no "expect" to say which it is, and nothing both of its sides pass tells it apart: they differ on options.mode ("reauth" from the command, not given from the tool)',
  );
});

test('parameter names are read from an operation’s source, as it is loaded with its types stripped', () => {
  // What `--experimental-strip-types` leaves of `planModeSet(context: SlackContext, alias: string, …)`.
  const stripped = new Function(
    'return async function planModeSet(\n  context              ,\n  alias        ,\n  wanted         ,\n  options                ,\n)                       { return [context, alias, wanted, options]; }',
  )();
  assert.deepEqual(parameterNames(stripped), ['context', 'alias', 'wanted', 'options']);
  function defaults(a = '(,', /* b, */ b = { c: [1, 2] }, ...rest) {
    return [a, b, rest];
  }
  assert.deepEqual(parameterNames(defaults), ['a', 'b', 'rest']);
  assert.deepEqual(
    parameterNames(({ a }, [b], c) => [a, b, c]),
    [null, null, 'c'],
    'a pattern has no name to expect by',
  );
  assert.deepEqual(
    parameterNames((x) => x),
    ['x'],
  );
  assert.deepEqual(
    parameterNames(async (x) => x),
    ['x'],
  );
  assert.deepEqual(
    parameterNames(() => 1),
    [],
  );
});

test('what an operation receives is recorded by parameter name, leaves only, and without running a getter', () => {
  class Context {
    surface = 'cli';
  }
  let ran = false;
  const options = {
    mode: 'add',
    port: 51234,
    detached: false,
    email: undefined,
    missing: null,
    scopes: ['a', 'b'],
    nested: { deeper: { deepest: 'too far' }, kept: true },
    listener: () => {},
    get secret() {
      ran = true;
      return 'x';
    },
  };
  assert.deepEqual(recordArguments([new Context(), 'work', options, 'extra'], ['context', 'alias', 'options']), {
    alias: 'work',
    'options.mode': 'add',
    'options.port': 51234,
    'options.detached': false,
    'options.missing': null,
    'options.scopes': ['a', 'b'],
    'options.nested.kept': true,
    3: 'extra',
  });
  assert.equal(ran, false, 'a getter is code, and recording runs none');
});
