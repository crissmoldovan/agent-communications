/**
 * What each package actually offers, read from the running product: every command its CLI answers to, and every tool
 * its MCP server registers.
 *
 * One derivation, two readers. `sync-reference.mjs` generates the reference pages from it, and `parity.mjs` (through
 * `test/parity.test.mjs`) checks `capabilities.json` against it. Two derivations would be two chances to disagree
 * about what exists, and the one that disagreed would be the one nobody reads.
 *
 * Both halves read the product rather than a description of it. The CLI half captures `--help` through the same code
 * path a person runs; the MCP half starts a server and asks it for `tools/list`. Everything runs from source, the way
 * the package test suites do, so neither answer depends on a build being current.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** How Node runs a TypeScript entry directly — the flags every package's own test script passes. */
const TS_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

/*
 * Every path the products could write to, pointed at one scratch directory.
 *
 * Setting only the config directory left the state and data directories to their defaults, which are the real ones
 * on the machine running this — something that only lists commands has no business near somebody's mailboxes.
 */
export const scratchEnv = (dir = join(ROOT, '.tmp-reference-config')) => ({
  ...process.env,
  NO_COLOR: '1',
  AGENT_COMMS_CONFIG_DIR: dir,
  AGENT_COMMS_STATE_DIR: join(dir, 'state'),
  AGENT_COMMS_DATA_DIR: join(dir, 'data'),
});

/**
 * The packages with a surface of their own: a CLI, and — when that CLI has an `mcp` command that runs — a server.
 *
 * `cli` says how the command tree is read. Gmail's and Slack's CLIs are Commander programs; the core's is not, and its
 * `--help` is one usage table with a line per command. `program` is the module exporting `run()`, imported directly
 * because `dist/cli.mjs` is a bin that runs on import and neither bundle re-exports `run`.
 */
export const SURFACES = Object.freeze([
  { package: 'core', binary: 'agentcomms', entry: 'packages/core/src/cli.ts', cli: 'usage' },
  {
    package: 'gmail',
    binary: 'agent-gmail',
    entry: 'packages/gmail/src/cli.ts',
    program: 'packages/gmail/src/cli/program.ts',
    cli: 'commander',
  },
  {
    package: 'slack',
    binary: 'agent-slack',
    entry: 'packages/slack/src/cli.ts',
    program: 'packages/slack/src/cli/program.ts',
    cli: 'commander',
  },
]);

/**
 * Packages that publish another package's surface under a second name, and so have none of their own to read.
 *
 * `@agentcomms/gmail-mcp` is one call to `createGmailMcpServer` — the server `agent-gmail mcp` runs. A package that
 * is neither here nor in `SURFACES` fails `test/parity.test.mjs`: Slack's server once shipped with eleven tools and a
 * reference for none of them, because the generator only knew Gmail's.
 */
export const WRAPPERS = Object.freeze({ 'gmail-mcp': 'gmail' });

export const surfaceOf = (name) => {
  const found = SURFACES.find((surface) => surface.package === name);
  if (!found) throw new Error(`no surface for package "${name}"`);
  return found;
};

// ── Commander's help, as a person sees it ────────────────────────────────────────────────────────────────────────

/**
 * Runs `--help` for a command through the real CLI, capturing what a person would see.
 *
 * `pathToFileURL`, not the bare path, for the import: on Windows an absolute path is `D:\\…`, which ESM rejects as an
 * unknown URL scheme — and that only ever shows up on Windows.
 */
async function commanderHelp(surface, argv, env) {
  const { run } = await import(pathToFileURL(join(ROOT, surface.program)).href);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let text = '';
  stdout.on('data', (c) => {
    text += c;
  });
  stderr.on('data', (c) => {
    text += c;
  });
  await run([...argv, '--help'], { streams: { stdout, stderr, stdin: new PassThrough() }, env });
  return text;
}

/** Splits Commander's help into its sections, which are stable and are what the user actually reads. */
export function sections(text) {
  const out = { usage: '', description: '', Arguments: [], Options: [], Commands: [] };
  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    const usage = /^Usage:\s*(.+)$/.exec(line);
    if (usage) {
      out.usage = usage[1].trim();
      current = 'description';
      continue;
    }
    const heading = /^(Arguments|Options|Commands):\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      continue;
    }
    if (/^\S/.test(line) && current && current !== 'description') current = null;
    if (!line.trim()) continue;
    if (current === 'description') out.description += `${line.trim()} `;
    else if (current && /^\s{3,}/.test(line) && out[current].length > 0) {
      // A wrapped continuation: Commander starts every entry two spaces in, and indents the rest of a long description
      // to line up under it. Read as its own entry, it became a row of its own — the flag column holding the tail of
      // the previous description, and the previous row's default cut off mid-sentence.
      out[current][out[current].length - 1] += ` ${line.trim()}`;
    } else if (current) out[current].push(line);
  }
  out.description = out.description.trim();
  return out;
}

/** One `  --flag <value>   what it does (default: x)` line into its parts. */
export function entry(line) {
  const m = /^\s{2,}(\S.*?)\s{2,}(.*)$/.exec(line);
  if (!m) return { name: line.trim(), text: '' };
  let text = m[2].trim();
  let fallback = '';
  const d = /\(default:\s*(.+?)\)\s*$/.exec(text);
  if (d) {
    fallback = d[1];
    text = text.slice(0, d.index).trim();
  }
  return { name: m[1].trim(), text, fallback };
}

/** The word a Commands entry is run by: `add` from `add [options] [alias]`, `organise` from `organise|organize`. */
const commandWord = (name) => name.split(' ')[0].split('|')[0];

/** Commander's own entry, which it adds to a command's list — see `commandTree` for what its presence means. */
const isHelpEntry = (name) => /^help\b/.test(name);

// ── The command tree ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every node of a CLI's command tree, root first and then in the order its help lists them:
 * `{ path, acts, subcommands, help }`, where `help` is that node's `--help` text.
 *
 * **`acts` is what separates a command from a group.** `agent-gmail inbox` does nothing itself: it groups `inbox add`,
 * `inbox list` and the rest. `agent-gmail mcp` groups `mcp install` and `mcp prune` *and* runs the server. Help text
 * cannot show an action handler, but Commander shows its absence: it lists its own `help [command]` entry only under
 * a command that has subcommands and no action (`_getHelpCommand` in `commander/lib/command.js`). So a node whose
 * list carries that entry is a group; every other node — every leaf, and a parent like `mcp` — is a command someone
 * runs. If Commander ever changes that, every group reads as a command or `mcp` reads as a group, and the parity
 * test fails on the table rather than passing on a wrong tree.
 *
 * The core CLI is not Commander. Its help is one usage table, a line per command, so there a path with a line of its
 * own acts, and a path that only prefixes others (`audit` in `audit tail`) is a group.
 *
 * Hidden commands are not in help and so not in the tree. There are two, `agent-gmail oauth-listen` and
 * `agent-slack sign-in-listen`: the half of a sign-in this software starts in the background, which no person or
 * agent is meant to run.
 */
export async function commandTree(surface, { env = scratchEnv() } = {}) {
  return surface.cli === 'usage' ? usageTree(surface, env) : commanderTree(surface, env);
}

async function commanderTree(surface, env) {
  const nodes = [];
  const visit = async (path) => {
    const help = await commanderHelp(surface, path, env);
    const parsed = sections(help);
    // Commander answers `--help` for a command it does not have with its parent's help, and exit 0. The usage line
    // names the command that actually answered, so a tree built from a misread entry fails here instead.
    const expected = [surface.binary, ...path].join(' ');
    if (!parsed.usage.startsWith(expected)) {
      throw new Error(`\`${expected} --help\` answered as \`${parsed.usage}\` — the command tree was misread`);
    }
    const listed = parsed.Commands.map(entry).map((c) => c.name);
    const subcommands = listed.filter((name) => !isHelpEntry(name)).map(commandWord);
    const acts = subcommands.length === 0 || !listed.some(isHelpEntry);
    nodes.push({ path, acts, subcommands, help });
    for (const word of subcommands) await visit([...path, word]);
  };
  await visit([]);
  return nodes;
}

async function usageTree(surface, env) {
  const help = await capture(surface, ['--help'], env);
  // The table is the block under `Usage:`, up to the first blank line; the options and exit codes follow it.
  const all = help.split(/\r?\n/);
  const start = all.findIndex((line) => /^Usage:\s*$/.test(line));
  const blank = all.findIndex((line, index) => index > start && !line.trim());
  const block = start === -1 ? [] : all.slice(start + 1, blank === -1 ? all.length : blank);
  const own = [];
  for (const line of block) {
    const rest = new RegExp(`^\\s+${surface.binary}\\s+(.*)$`).exec(line)?.[1];
    if (rest === undefined) continue;
    // The description, when a line has one, sits after a run of spaces; the command ends at its first argument.
    const words = [];
    for (const word of rest
      .split(/\s{2,}/)[0]
      .trim()
      .split(/\s+/)) {
      if (!/^[a-z][a-z-]*$/.test(word)) break;
      words.push(word);
    }
    if (words.length > 0) own.push(words);
  }
  if (own.length === 0)
    throw new Error(`\`${surface.binary} --help\` has no usage table — the command tree was misread`);

  const key = (path) => path.join(' ');
  const acting = new Set(own.map(key));
  const nodes = [{ path: [], acts: false, subcommands: [], help }];
  const seen = new Map([['', nodes[0]]]);
  for (const path of own) {
    for (let depth = 1; depth <= path.length; depth += 1) {
      const prefix = path.slice(0, depth);
      if (seen.has(key(prefix))) continue;
      const node = { path: prefix, acts: acting.has(key(prefix)), subcommands: [], help };
      seen.get(key(prefix.slice(0, -1))).subcommands.push(prefix.at(-1));
      seen.set(key(prefix), node);
      nodes.push(node);
    }
  }
  return nodes;
}

/** Runs a surface's entry with `argv` and returns everything it printed, whatever it exited with. */
function capture(surface, argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...TS_FLAGS, join(ROOT, surface.entry), ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let text = '';
    child.stdout.on('data', (c) => {
      text += c;
    });
    child.stderr.on('data', (c) => {
      text += c;
    });
    child.on('error', reject);
    child.on('close', () => resolve(text));
  });
}

// ── The tools a server registers ─────────────────────────────────────────────────────────────────────────────────

/** Asks a live server what it offers — `<entry> mcp`, as a client starts it — so nothing describes a tool it lacks. */
export async function serverTools(surface, { env = scratchEnv() } = {}) {
  const child = spawn(process.execPath, [...TS_FLAGS, join(ROOT, surface.entry), 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  let buf = '';
  let err = '';
  let exited = false;
  child.stdout.on('data', (c) => {
    buf += c;
  });
  child.stderr.on('data', (c) => {
    err += c;
  });
  child.on('exit', () => {
    exited = true;
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reference', version: '0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const deadline = Date.now() + 30_000;
  let list = null;
  // A server that died will never answer; waiting out the deadline for it only hid why.
  while (Date.now() < deadline && !list && !exited) {
    await new Promise((r) => setTimeout(r, 100));
    for (const line of buf.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const m = JSON.parse(line);
        if (m.id === 2) list = m.result;
      } catch {
        /* a partial line: the next chunk completes it */
      }
    }
  }
  child.kill();
  if (!list) throw new Error(`\`${surface.binary} mcp\` did not answer tools/list${err ? `:\n${err}` : ''}`);
  return list.tools;
}

// ── Both registries, for the parity check ────────────────────────────────────────────────────────────────────────

/**
 * Per package: `{ binary, commands, groups, tools }` — command paths without the binary (`inbox add`), and tool names.
 *
 * A package serves tools when its CLI has an `mcp` command that acts, and those tools are what that server lists.
 * Derived rather than listed, so the core's server is read the moment `agentcomms mcp` exists, with nothing to
 * remember to add here.
 */
export async function deriveRegistries({ env = scratchEnv() } = {}) {
  // In parallel, but assembled in `SURFACES` order, so every report lists packages the same way on every run.
  const entries = await Promise.all(
    SURFACES.map(async (surface) => {
      const nodes = (await commandTree(surface, { env })).filter((node) => node.path.length > 0);
      const serves = nodes.some((node) => node.acts && node.path.join(' ') === 'mcp');
      return [
        surface.package,
        {
          binary: surface.binary,
          commands: nodes.filter((node) => node.acts).map((node) => node.path.join(' ')),
          groups: nodes.filter((node) => !node.acts).map((node) => node.path.join(' ')),
          tools: serves ? (await serverTools(surface, { env })).map((tool) => tool.name) : [],
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}
