#!/usr/bin/env node
/**
 * CLI and MCP parity, checked against `capabilities.json`.
 *
 * The owner's rule (docs/superpowers/specs/2026-09-25-cli-mcp-parity-design.md): everything can be done both ways,
 * from a terminal and from a chat. A command with no tool, or a tool with no command, is a defect. The table says, for
 * every capability, which command and which tool provide it; this checks the table against both registries as they
 * are read from the product (`registries.mjs`), in both directions, on every run.
 *
 *   node scripts/parity.mjs            # the table covers everything that exists, and names nothing that does not
 *   node scripts/parity.mjs --strict   # …and nothing is still pending — what a release has to pass
 *
 * `test/parity.test.mjs` runs the same check inside `pnpm test`, and mutation-tests every rule below.
 */
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const FIELDS = new Set(['id', 'package', 'cli', 'mcp', 'status', 'phase', 'reason']);

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

/** The table as committed. */
export async function readTable(path = TABLE) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Run directly: derive, check, and print. Compared through realpath because a runner's temp directory can be a
// symlink (macOS `/tmp` → `/private/tmp`), and a plain comparison would then do nothing and exit 0.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const strict = process.argv.includes('--strict');
  // A directory of its own, removed afterwards: listing commands and tools should leave nothing behind, anywhere.
  const scratch = await mkdtemp(join(tmpdir(), 'agentcomms-parity-'));
  try {
    const problems = checkParity(await readTable(), await deriveRegistries({ env: scratchEnv(scratch) }), { strict });
    if (problems.length > 0) {
      console.error(`capabilities.json and the product disagree${strict ? ' (strict)' : ''}:\n`);
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('\nSee CONTRIBUTING.md, "Adding a capability".');
      process.exitCode = 1;
    } else {
      console.log(`capabilities.json matches every command and tool${strict ? ', and nothing is pending' : ''}.`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
