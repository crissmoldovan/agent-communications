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
 * - `expect`: argument values the operation must receive from both sides, by the name of its parameter, or a path into
 *   one — `{ "wanted": "read" }`, `{ "request.channel": "gmail" }`; `null` is "not given". What tells apart rows that
 *   run one operation: see `checkOperations`.
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
  'expect',
  'unchecked',
]);

/** The fields that describe what a row's two sides run, which only a row with two sides can have. */
const OPERATION_FIELDS = Object.freeze(['operation', 'via', 'argv', 'args', 'expect', 'unchecked']);

/** An `expect` key: a parameter's name, or a path of keys into it. */
const EXPECT_KEY = /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/;

/** A value `expect` can hold: what the drive records (`recordArguments` in operations.mjs), and `null` for not given. */
const expectable = (value) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

/** An argument's value as a sentence shows it. */
const shown = (value) => (value === undefined || value === null ? 'not given' : JSON.stringify(value));

/** Whether two recorded or expected values are the same; not given and `null` are one. */
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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
    if (row.expect !== undefined) {
      const entries =
        row.expect !== null && typeof row.expect === 'object' && !Array.isArray(row.expect)
          ? Object.entries(row.expect)
          : [];
      if (entries.length === 0) {
        problems.push(
          `${at}: "expect" must be an object of what its operation receives, by parameter name — {"wanted": "read"}`,
        );
      }
      for (const [key, value] of entries) {
        if (!EXPECT_KEY.test(key)) {
          problems.push(`${at}: "expect" names "${key}", which is not a parameter's name or a path into one`);
        }
        if (!expectable(value) && !(Array.isArray(value) && value.every(expectable))) {
          problems.push(
            `${at}: "expect" gives "${key}" a value that is not a string, a number, true or false, a list of those, or null for not given`,
          );
        }
      }
      if (Array.isArray(row.operation)) {
        problems.push(
          `${at} names several operations and has "expect"; "expect" is what one operation receives, so it needs one`,
        );
      }
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
      if (row.expect !== undefined && row.operation === undefined) {
        problems.push(`${at} has "expect" but no "operation"; "expect" is what that operation receives`);
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
 * replaced by a stand-in that records the call, and what the row's own operation received, and does nothing. A side
 * passes when it reaches every operation the row names before it reaches any operation another row names, and that
 * operation received what the row's `expect` says. So:
 *
 * - a row whose command and tool are different operations fails on the side that runs the other one — the reviewer's
 *   swap of `gmail.search` and `gmail.trash` fails on both rows, each naming the tool that reached the other's;
 * - a row naming the wrong operation fails on both sides, saying what each one reached instead;
 * - naming a helper that every command calls on its way (`requireWorkspace`) makes it another row's operation, so
 *   every row that reaches it first fails — a table cannot pass by naming what everything calls.
 *
 * Reaching the operation cannot tell apart rows that share one. Four Slack rows run `planModeSet`, one per mode, and
 * swapping the tools of `slack.mode.report` and `slack.mode.narrow` passed everything above. So when two rows run one
 * operation through another command *and* another tool, each has to say in `expect` what that operation receives from
 * both of its sides, and the two have to expect a different value of some argument: then a side moved from one row
 * to the other brings the other's value with it, and fails. Two rows that share a whole side — the same command with
 * the same words, or the same tool with the same arguments — need nothing: exchanging their other sides exchanges
 * which id each pairing is filed under, and pairs nothing new (`gmail_inbox_finish` finishes both kinds of sign-in
 * that `inbox add --finish` and `inbox reauth --finish` each finish one of).
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
  /** Every operation some checked row names, with the rows that name it: who has to be told apart from whom. */
  const sharing = new Map();
  /** Each row's `expect`, as entries, where it is well formed (`checkParity` reports it where it is not). */
  const expectations = new Map();

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
    for (const id of wanted) sharing.set(id, [...(sharing.get(id) ?? []), row]);
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
    // What the operation has to receive, by the names its own source gives its parameters. A name it does not have
    // would expect nothing of anything, so it is refused rather than compared.
    const expected = [];
    const one = resolved.length === 1 ? resolved[0] : null;
    if (one && isEntries(row.expect)) {
      const parameters = driven?.parameters?.[one.id];
      for (const [key, value] of Object.entries(row.expect)) {
        const parameter = key.split('.')[0];
        if (Array.isArray(parameters) && !parameters.includes(parameter)) {
          const takes = parameters.filter(Boolean).join(', ') || 'no named parameters';
          problems.push(`${at} expects "${key}", but ${one.name} has no parameter "${parameter}"; it takes ${takes}`);
        } else expected.push([key, value]);
      }
      if (expected.length === Object.keys(row.expect).length) expectations.set(row, expected);
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
      if (missing.length === 0) {
        const received = outcome.received?.[one?.id] ?? {};
        for (const [key, value] of expected) {
          if (same(received[key], value)) continue;
          problems.push(
            `${at}: ${surface} reaches ${one.name} with ${key} ${shown(received[key])}, where the row expects ${shown(value)}`,
          );
        }
        continue;
      }
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

  // ── Rows that run one operation are told apart by what it receives ──
  const report = (row, side) => driven?.reports?.[row.id]?.[side];
  const commandOf = (row) => JSON.stringify([row.package, row.cli, report(row, 'cli')?.argv ?? row.argv ?? []]);
  const toolOf = (row) => JSON.stringify([row.mcp, sorted(report(row, 'mcp')?.args ?? row.args ?? {})]);
  for (const [id, group] of sharing) {
    const unlike = new Map(group.map((row) => [row, []]));
    group.forEach((first, index) => {
      for (const second of group.slice(index + 1)) {
        if (commandOf(first) === commandOf(second) || toolOf(first) === toolOf(second)) continue;
        unlike.get(first).push(second);
        unlike.get(second).push(first);
        const [a, b] = [expectations.get(first), expectations.get(second)];
        if (a && b && !a.some(([key, value]) => b.some(([other, theirs]) => other === key && !same(value, theirs)))) {
          problems.push(
            `rows "${first.id}" and "${second.id}" both run ${nameOf(id)}, through another command and another tool, and their "expect" does not tell them apart: name an argument each expects a different value of`,
          );
        }
      }
    });
    for (const [row, others] of unlike) {
      if (others.length > 0 && !expectations.has(row) && row.expect === undefined) {
        problems.push(tellApart(row, others, id, report, nameOf));
      }
    }
  }
  return problems;
}

/** Whether `expect` is a well-formed object of entries — the only kind `checkOperations` compares. */
function isEntries(expect) {
  return (
    expect !== null &&
    typeof expect === 'object' &&
    !Array.isArray(expect) &&
    Object.keys(expect).length > 0 &&
    Object.entries(expect).every(
      ([key, value]) =>
        EXPECT_KEY.test(key) && (expectable(value) || (Array.isArray(value) && value.every(expectable))),
    )
  );
}

/** A plain object with its keys in order, so two tools' arguments compare as the same call however they were written. */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

/**
 * The problem for a row that shares its operation, through another command and another tool, with `others`, and says
 * nothing in `expect`: with the arguments that would tell it apart — ones both of its sides pass alike, and each of
 * the others' pass otherwise — or, where there are none, the arguments that differ from row to row on which its own
 * two sides disagree: a real difference between its command and its tool, or `argv` or `args` that miss the argument.
 */
function tellApart(row, others, id, report, nameOf) {
  const received = (of, side) => report(of, side)?.received?.[id];
  const whom = `${others.length === 1 ? 'row' : 'rows'} ${others.map((other) => `"${other.id}"`).join(', ')}`;
  const head = `row "${row.id}" runs ${nameOf(id)}, as ${whom} ${others.length === 1 ? 'does' : 'do'}, through another command and another tool, and has no "expect" to say which it is`;
  const [cli, mcp] = [received(row, 'cli'), received(row, 'mcp')];
  if (!cli || !mcp) return `${head}; name an argument its operation receives from both of its sides`;
  const keys = new Set(
    [cli, mcp, ...others.flatMap((other) => [received(other, 'cli'), received(other, 'mcp')])].flatMap((recorded) =>
      Object.keys(recorded ?? {}),
    ),
  );
  const telling = [...keys].sort().filter(
    (key) =>
      same(cli[key], mcp[key]) &&
      others.every((other) => {
        const [theirs, alsoTheirs] = [received(other, 'cli'), received(other, 'mcp')];
        return theirs && alsoTheirs && same(theirs[key], alsoTheirs[key]) && !same(theirs[key], cli[key]);
      }),
  );
  if (telling.length > 0) {
    const suggestion = Object.fromEntries(telling.slice(0, 2).map((key) => [key, cli[key] ?? null]));
    return `${head}: both of its sides pass ${telling
      .slice(0, 3)
      .map((key) => `${key} ${shown(cli[key])}`)
      .join(', ')}, and theirs do not — "expect": ${JSON.stringify(suggestion)}`;
  }
  // What every command passes alike, and every tool alike, is how surfaces differ (`detached`), not how rows do.
  const varies = (key) =>
    others.some(
      (other) => !same(received(other, 'cli')?.[key], cli[key]) || !same(received(other, 'mcp')?.[key], mcp[key]),
    );
  const split = [...keys]
    .sort()
    .filter((key) => !same(cli[key], mcp[key]) && varies(key))
    .slice(0, 3)
    .map((key) => `${key} (${shown(cli[key])} from the command, ${shown(mcp[key])} from the tool)`);
  return `${head}, and nothing both of its sides pass tells it apart${split.length > 0 ? `: they differ on ${split.join(', ')}` : ''}`;
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
