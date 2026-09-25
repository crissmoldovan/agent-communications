#!/usr/bin/env node
/**
 * CLI and MCP parity, checked against `capabilities.json`.
 *
 * The owner's rule (docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md): everything can be done both ways,
 * from a terminal and from a chat. A command with no tool, or a tool with no command, is a defect. The table says, for
 * every capability, which command and which tool provide it, and which operation both of them run; this checks the
 * table against both registries as they are read from the product (`registries.mjs`), in both directions, and against
 * what each row's command and tool actually call when they are run (`operations.mjs`), on every run.
 *
 *   node scripts/parity.mjs            # the table covers everything that exists, names nothing that does not, and
 *                                      # every row's command and tool reach the operation it names
 *   node scripts/parity.mjs --strict   # …and nothing is still pending — what a release has to pass
 *
 * Names alone were not enough: swapping two rows' tools (`gmail.search` with `gmail.trash`) passed, because both
 * sides of each row still existed. That is how the channels' `mcp install` shipped without the approval its paired
 * tool required. Design §7 asks for more — the two sides of a row are the same operation — and `checkOperations` is
 * that rule.
 *
 * `test/parity.test.mjs` runs the same check inside `pnpm test`, and mutation-tests every rule below.
 */
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driveOperations, namedOperations, operationNames, resolveOperation } from './operations.mjs';
import { deriveRegistries, ROOT, scratchEnv } from './registries.mjs';

export const TABLE = join(ROOT, 'capabilities.json');

/**
 * What a row's `status` may be.
 *
 * - `both`: the command and the tool are the same capability.
 * - `exception`: one side, on purpose, with the `reason` inline — so an asymmetry is visible in review rather than
 *   implied by a row that is missing.
 * - `pending`: one side, until the `phase` of the design that adds the other lands. A release allows none.
 */
export const STATUSES = Object.freeze(['both', 'pending', 'exception']);

/** The design's phases that add a surface; P1 is core machinery with no command or tool of its own. */
export const PHASES = Object.freeze(['P2', 'P3', 'P4', 'P5', 'P6']);

/**
 * Every field a row may carry.
 *
 * - `operation`: what a `both` row's command and tool both run — the name of a function exported from
 *   `packages/<package>/src/operations/` (or the core's, which a channel's `mcp install` runs), or a list of them for
 *   a command made of several. Checked by running both sides: see `checkOperations`.
 * - `via`: operations other rows name that a side passes through before this row's — `setup` reads the state
 *   (`setupState`, row `gmail.setup`) before it starts a sign-in. Without it, reaching another row's operation first
 *   fails the row.
 * - `argv`, `args`: what the check runs the command and the tool with, when the smallest call they accept does not
 *   reach the operation — `--finish <flowId>` for the half of `inbox add` that finishes a sign-in.
 * - `unchecked`: instead of `operation`, why this row's two sides are not checked — where a reviewer reads it.
 */
const FIELDS = new Set([
  'id',
  'package',
  'cli',
  'mcp',
  'status',
  'phase',
  'reason',
  'operation',
  'via',
  'argv',
  'args',
  'unchecked',
]);

/** The fields that describe what a row's two sides run, which only a row with two sides can have. */
const OPERATION_FIELDS = Object.freeze(['operation', 'via', 'argv', 'args', 'unchecked']);

/**
 * Every way `table` and `registries` disagree, as sentences naming what is missing; empty when they agree.
 *
 * `registries` is `deriveRegistries()`'s shape: per package, its command paths, its groups and its tools.
 *
 * A command may be named by more than one row, and so may a tool, because the relation is not one to one in either
 * direction. `agent-gmail inbox add` starts a sign-in and, with `--finish`, completes one; MCP gives those two tools,
 * because a tool call cannot sit waiting on a browser. And the design's core server installs every channel's server,
 * so one `comms_server_install` will stand behind `agent-gmail mcp install` and `agent-slack mcp install` alike. What
 * a row may not do is repeat another row, or pair a side that an `exception` row says has no counterpart.
 */
export function checkParity(table, registries, { strict = false } = {}) {
  const rows = table?.capabilities;
  if (!Array.isArray(rows)) return ['capabilities.json has no "capabilities" array'];

  const problems = [];
  const packages = Object.keys(registries);
  const command = (pkg, path) => `\`${registries[pkg].binary} ${path}\``;
  const label = (row, index) => (typeof row?.id === 'string' && row.id ? `row "${row.id}"` : `row ${index + 1}`);

  /** Which package's server registers each tool. Names are unique across servers; a clash is reported, not merged. */
  const servedBy = new Map();
  for (const pkg of packages) {
    for (const tool of registries[pkg].tools) {
      if (servedBy.has(tool))
        problems.push(`the MCP tool ${tool} is registered by both ${servedBy.get(tool)} and ${pkg}`);
      else servedBy.set(tool, pkg);
    }
  }

  const ids = new Set();
  const pairs = new Map();
  rows.forEach((row, index) => {
    const at = label(row, index);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`${at} is not an object`);
      return;
    }
    // An unknown field is nearly always a misspelt known one, and a misspelt `phase` reads as no phase at all.
    for (const key of Object.keys(row)) if (!FIELDS.has(key)) problems.push(`${at} has an unknown field "${key}"`);

    if (typeof row.id !== 'string' || !row.id) problems.push(`${at} has no "id"`);
    else if (ids.has(row.id)) problems.push(`${at} appears twice; every id names one row`);
    else ids.add(row.id);

    const registry = registries[row.package];
    if (!registry) {
      problems.push(`${at} names package "${row.package}", which is not one of: ${packages.join(', ')}`);
      return;
    }
    for (const side of ['cli', 'mcp']) {
      if (row[side] !== null && (typeof row[side] !== 'string' || !row[side])) {
        problems.push(`${at}: "${side}" must be a ${side === 'cli' ? 'command path' : 'tool name'}, or null`);
      }
    }
    const cli = typeof row.cli === 'string' && row.cli ? row.cli : null;
    const mcp = typeof row.mcp === 'string' && row.mcp ? row.mcp : null;

    // ── What the row names has to exist ──
    if (cli && !registry.commands.includes(cli)) {
      problems.push(
        registry.groups.includes(cli)
          ? `${at} names ${command(row.package, cli)}, which only groups other commands; name the subcommand that does the work`
          : `${at} names ${command(row.package, cli)}, which does not exist`,
      );
    }
    if (mcp) {
      const server = servedBy.get(mcp);
      if (!server) problems.push(`${at} names the MCP tool ${mcp}, which no server registers`);
      // A channel's capability is served by that channel's server — or by the core's, which installs and manages the
      // others (§5). Anything else is a row pointing at the wrong product.
      else if (server !== row.package && server !== 'core') {
        problems.push(`${at} is a ${row.package} capability, but ${mcp} is registered by the ${server} server`);
      }
    }

    // ── The status says what the row may look like ──
    if (!STATUSES.includes(row.status)) {
      problems.push(`${at} has status "${row.status}"; it must be one of: ${STATUSES.join(', ')}`);
    } else if (row.status === 'both') {
      if (!cli) problems.push(`${at} is "both" but names no CLI command`);
      if (!mcp) problems.push(`${at} is "both" but names no MCP tool`);
    } else {
      if (cli && mcp)
        problems.push(`${at} is "${row.status}" but names both sides; if they are one capability, it is "both"`);
      if (!cli && !mcp) problems.push(`${at} is "${row.status}" but names neither a command nor a tool`);
      if (row.status === 'exception' && (typeof row.reason !== 'string' || !row.reason.trim())) {
        problems.push(`${at} is an exception with no "reason"; an exception has to say why, where a reviewer reads it`);
      }
      if (row.status === 'pending' && !PHASES.includes(row.phase)) {
        problems.push(
          row.phase === undefined
            ? `${at} is pending with no "phase"; say which of ${PHASES.join(', ')} adds the missing side`
            : `${at} is pending in phase "${row.phase}", which is not one of: ${PHASES.join(', ')}`,
        );
      }
    }
    // A phase left on a finished row is a stale promise, and the next reader would believe it.
    if (row.phase !== undefined && row.status !== 'pending') {
      problems.push(`${at} is "${row.status}" but still carries phase "${row.phase}"; only a pending row has one`);
    }

    // ── What the two sides run ──
    for (const field of ['operation', 'via']) {
      if (row[field] === undefined) continue;
      const list = typeof row[field] === 'string' ? [row[field]] : row[field];
      const names = Array.isArray(list) ? list : [];
      if (
        names.length === 0 ||
        names.some((name) => typeof name !== 'string' || !name) ||
        new Set(names).size !== names.length
      ) {
        problems.push(
          `${at}: "${field}" must name a function exported from packages/${row.package}/src/operations, or be a list of distinct names`,
        );
      }
    }
    if (row.unchecked !== undefined && (typeof row.unchecked !== 'string' || !row.unchecked.trim())) {
      problems.push(
        `${at} has an empty "unchecked"; a row that is not checked has to say why, where a reviewer reads it`,
      );
    }
    if (row.argv !== undefined && (!Array.isArray(row.argv) || row.argv.some((word) => typeof word !== 'string'))) {
      problems.push(`${at}: "argv" must be a list of the words to add to the command`);
    }
    if (row.args !== undefined && (row.args === null || typeof row.args !== 'object' || Array.isArray(row.args))) {
      problems.push(`${at}: "args" must be an object of arguments for the tool`);
    }
    if (row.status === 'both') {
      if (row.operation === undefined && row.unchecked === undefined) {
        problems.push(
          `${at} is "both" but names no "operation": the function of packages/${row.package}/src/operations that its command and its tool both run`,
        );
      }
      if (row.operation !== undefined && row.unchecked !== undefined) {
        problems.push(`${at} names an "operation" and says it is "unchecked"; it is one or the other`);
      }
      if (row.via !== undefined && row.operation === undefined) {
        problems.push(`${at} has "via" but no "operation"; "via" is what a side passes through on its way to it`);
      }
    } else if (STATUSES.includes(row.status)) {
      for (const key of OPERATION_FIELDS) {
        if (row[key] !== undefined) {
          problems.push(`${at} is "${row.status}" but carries "${key}"; only a "both" row has two sides to compare`);
        }
      }
    }

    const pair = JSON.stringify([row.package, cli, mcp]);
    if (pairs.has(pair)) problems.push(`${at} repeats row "${pairs.get(pair)}"`);
    else pairs.set(pair, row.id);

    if (strict && row.status === 'pending') {
      problems.push(
        `${at} is still pending (${row.phase}): ${cli ? command(row.package, cli) : mcp} has no ${cli ? 'MCP tool' : 'CLI command'} — a release needs it "both", or an "exception" with its reason`,
      );
    }
  });

  const valid = rows.filter((row) => row && typeof row === 'object');

  // ── An exception is a claim that its side has no counterpart; no other row may pair it ──
  for (const row of valid.filter((r) => r.status === 'exception')) {
    for (const other of valid) {
      if (other === row) continue;
      const clash = row.cli
        ? other.package === row.package && other.cli === row.cli
        : Boolean(row.mcp) && other.mcp === row.mcp;
      if (clash) {
        const name = row.cli ? command(row.package, row.cli) : row.mcp;
        problems.push(`row "${row.id}" says ${name} has no counterpart, but row "${other.id}" names it too`);
      }
    }
  }

  // ── Everything that exists is in the table ──
  for (const pkg of packages) {
    for (const path of registries[pkg].commands) {
      if (!valid.some((row) => row.package === pkg && row.cli === path)) {
        problems.push(
          `${command(pkg, path)} is a command, but no row of capabilities.json names it — add one with "package": "${pkg}", "cli": "${path}"`,
        );
      }
    }
    for (const tool of registries[pkg].tools) {
      if (!valid.some((row) => row.mcp === tool)) {
        problems.push(
          `${tool} is an MCP tool, but no row of capabilities.json names it — add one with "mcp": "${tool}"`,
        );
      }
    }
  }
  return problems;
}

/**
 * Every way a row's command and tool fail to run the operation it names, from what `driveOperations()` saw them call.
 *
 * Each side of a `both` row was run — the command in-process, the tool through an MCP client — with every operation
 * replaced by a stand-in that records the call and does nothing. A side passes when it reaches every operation the
 * row names before it reaches any operation another row names. So:
 *
 * - a row whose command and tool are different operations fails on the side that runs the other one — the reviewer's
 *   swap of `gmail.search` and `gmail.trash` fails on both rows, each naming the tool that reached the other's;
 * - a row naming the wrong operation fails on both sides, saying what each one reached instead;
 * - naming a helper that every command calls on its way (`requireWorkspace`) makes it another row's operation, so
 *   every row that reaches it first fails — a table cannot pass by naming what everything calls.
 *
 * A row with `unchecked` is skipped, and says why in the table. Sides the name check already reports as missing are
 * left to it. `registries` is `deriveRegistries()`'s shape, for the commands' binaries; `driven` is
 * `driveOperations()`'s result.
 */
export function checkOperations(table, registries, driven) {
  const rows = Array.isArray(table?.capabilities) ? table.capabilities : [];
  const problems = [];
  if (driven?.fatal) problems.push(`the operations drive stopped early: ${driven.fatal}`);
  const operations = driven?.operations ?? {};
  const named = namedOperations(rows, operations);
  const toolExists = (tool) => Object.values(registries).some((registry) => registry.tools.includes(tool));
  const nameOf = (id) => id.slice(id.indexOf(':') + 1);

  rows.forEach((row, index) => {
    if (row?.status !== 'both' || row.unchecked !== undefined) return;
    const names = operationNames(row);
    const at = typeof row.id === 'string' && row.id ? `row "${row.id}"` : `row ${index + 1}`;
    if (names.length === 0) {
      // `checkParity` says the field is missing; what the two sides were seen to call says what to write in it.
      const report = driven?.reports?.[row.id];
      if (!report?.cli || !report?.mcp) return;
      const byCli = new Set(report.cli.calls);
      const shared = [...new Set(report.mcp.calls)].filter((id) => byCli.has(id)).map(nameOf);
      const list = (calls) => [...new Set(calls)].map(nameOf).join(', ') || 'none';
      problems.push(
        shared.length > 0
          ? `${at}: its command and its tool both reach ${shared.join(', ')} — name the one that does the work as its "operation"`
          : `${at}: its command and its tool reach no operation in common — the command reaches ${list(report.cli.calls)}; the tool, ${list(report.mcp.calls)}`,
      );
      return;
    }
    const resolved = names.map((name) => ({ name, ...resolveOperation(operations, row.package, name) }));
    for (const entry of resolved.filter((e) => !e.id)) {
      problems.push(`${at} names the operation "${entry.name}", but ${entry.problem}`);
    }
    if (resolved.some((entry) => !entry.id)) return;
    const wanted = new Set(resolved.map((entry) => entry.id));
    // What the row says a side passes through first. Each has to be another row's operation — otherwise it stops
    // nothing, and is only a name for a reader to wonder about.
    const via = new Set();
    for (const name of operationNames(row, 'via')) {
      const entry = resolveOperation(operations, row.package, name);
      if (!entry.id) problems.push(`${at} lists "${name}" under "via", but ${entry.problem}`);
      else if (!named.has(entry.id) || wanted.has(entry.id)) {
        problems.push(`${at} lists "${name}" under "via", but no other row names it; take it out`);
      } else via.add(entry.id);
    }
    const registry = registries[row.package];

    for (const side of ['cli', 'mcp']) {
      // A side that does not exist is the name check's to report; there was nothing here to run.
      if (side === 'cli' && !registry?.commands.includes(row.cli)) continue;
      if (side === 'mcp' && !toolExists(row.mcp)) continue;
      const outcome = driven?.reports?.[row.id]?.[side];
      const surface =
        side === 'cli'
          ? `\`${registry.binary} ${(outcome?.argv ?? [row.cli]).join(' ')}\``
          : `${row.mcp} ${JSON.stringify(outcome?.args ?? {})}`;
      if (!outcome) {
        if (!driven?.fatal) problems.push(`${at}: ${surface} was not run`);
        continue;
      }
      const calls = outcome.calls ?? [];
      const foreign = calls.findIndex((id) => named.has(id) && !wanted.has(id) && !via.has(id));
      const before = foreign === -1 ? calls : calls.slice(0, foreign);
      const missing = resolved.filter((entry) => !before.includes(entry.id));
      if (missing.length === 0) continue;
      const want = missing.map((entry) => `${entry.name} (${entry.module})`).join(' and ');
      if (foreign !== -1) {
        const other = calls[foreign];
        const owners = named
          .get(other)
          .map((id) => `"${id}"`)
          .join(', ');
        problems.push(`${at}: ${surface} reaches ${nameOf(other)} — the operation of row ${owners} — before ${want}`);
        continue;
      }
      const seen = [...new Set(calls)].map(nameOf);
      const reached = seen.length > 0 ? `it reaches ${seen.join(', ')}` : 'it reaches no operation at all';
      const ended = outcome.timedOut ? ', and did not finish' : outcome.refusal ? `, and ends: ${outcome.refusal}` : '';
      problems.push(`${at}: ${surface} never reaches ${want}; ${reached}${ended}`);
    }
  });
  return problems;
}

/**
 * Every problem with `table`: its names against `registries` (`checkParity`), and what each row's two sides run
 * (`checkOperations`, after driving them in a sealed process working in `dir`).
 */
export async function verifyParity({ table, registries, strict = false, dir }) {
  const problems = checkParity(table, registries, { strict });
  const driven = await driveOperations(table, { dir });
  return [...problems, ...checkOperations(table, registries, driven)];
}

/** The rows whose operation is not checked, with why: printed on every run, so none of them goes quiet. */
export function uncheckedRows(table) {
  return (Array.isArray(table?.capabilities) ? table.capabilities : []).filter(
    (row) => row?.status === 'both' && typeof row.unchecked === 'string',
  );
}

/** The table as committed. */
export async function readTable(path = TABLE) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Run directly: derive, check, and print. Compared through realpath because a runner's temp directory can be a
// symlink (macOS `/tmp` → `/private/tmp`), and a plain comparison would then do nothing and exit 0.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const strict = process.argv.includes('--strict');
  // A directory of its own, removed afterwards: listing commands and tools, and running them against stand-ins, should
  // leave nothing behind, anywhere.
  const scratch = await mkdtemp(join(tmpdir(), 'agentcomms-parity-'));
  try {
    const table = await readTable();
    // Independent, so at the same time: the drive is a process of its own, and so are the servers the registries ask.
    const [registries, driven] = await Promise.all([
      deriveRegistries({ env: scratchEnv(join(scratch, 'registries')) }),
      driveOperations(table, { dir: join(scratch, 'drive') }),
    ]);
    const problems = [...checkParity(table, registries, { strict }), ...checkOperations(table, registries, driven)];
    if (problems.length > 0) {
      console.error(`capabilities.json and the product disagree${strict ? ' (strict)' : ''}:\n`);
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('\nSee CONTRIBUTING.md, "Adding a capability".');
      process.exitCode = 1;
    } else {
      console.log(
        `capabilities.json matches every command and tool, and each row's command and tool reach its operation${strict ? '; nothing is pending' : ''}.`,
      );
    }
    const unchecked = uncheckedRows(table);
    if (unchecked.length > 0) {
      console.log(`\nNot checked for one operation (${unchecked.length}), each saying why in capabilities.json:`);
      for (const row of unchecked) console.log(`  - ${row.id}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
