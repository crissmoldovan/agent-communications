#!/usr/bin/env node
/**
 * Which operation each command and each tool actually reaches — the half of the parity check that reads behaviour
 * rather than names.
 *
 * `capabilities.json` pairs a command with a tool, and says which exported function of `packages/<package>/src/
 * operations/` both run (`"operation"`). `registries.mjs` proves both sides exist; only running them proves they are
 * the same operation. A reviewer swapped `gmail.search` with `gmail.trash`, and `slack.post.send` with `slack.read`,
 * and the name check passed both — which is how the channels' `mcp install` shipped without the approval its paired
 * tool asked for.
 *
 * So each row's command and tool are driven, and what they call is recorded:
 *
 * - **Every operation is replaced, never run.** In the process that drives them, every import a command or a server
 *   makes of an `operations/` module — and of `@agentcomms/core`'s operations, which the channels' `mcp install` and
 *   `mcp prune` call — goes to a stand-in that records the call and returns an inert value. Nothing an operation does
 *   happens: no mail is read, nothing is posted, no configuration is written, no sign-in starts. What runs is the
 *   surface itself — argument parsing, the schema a client's call is checked against, the guards before the call —
 *   which is exactly the part that decides which operation is reached.
 * - **A drive stops at the row's operation**, or at the first operation *another* row names, whichever comes first.
 *   The second is what makes a wrong row hard to pass: a command reaching `trash` before `search` has reached another
 *   row's operation, and naming a helper every command calls (`requireWorkspace`) as a row's operation makes every
 *   other row that reaches it first fail too. A command that really does pass through another row's operation on its
 *   way — `setup` reads the state (`gmail.setup`'s `setupState`) before it starts a sign-in — says so in `via`.
 * - **What the row's operation receives is recorded**, by the names of its own parameters: `planModeSet`'s `wanted`,
 *   `serverInstallChange`'s `request.channel`. Several rows can share one operation — four Slack rows run
 *   `planModeSet`, one per mode — and reaching it cannot tell them apart; only what it was asked can. Swapping the
 *   tools of `slack.mode.report` and `slack.mode.narrow` passed until a row said, in `expect`, which mode it asks for.
 * - **The process is sealed** besides: a temp HOME and `AGENT_COMMS_*` directories with the file secret store pinned,
 *   no network (`fetch`, sockets, requests, datagrams, name lookups), no child processes or worker threads, the
 *   account's home directory answered with the temp HOME, and `@napi-rs/keyring` refused — so a stand-in that failed
 *   to stand in still could not reach a keychain, Gmail or Slack.
 *
 * `driveOperations()` runs the drive in a child process (the import hooks have to be in place before any surface is
 * loaded) and returns what each row's two sides reached; `checkOperations()` in `parity.mjs` judges it.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = import.meta.url;

/**
 * Each package's two surfaces, as the drive loads them: the module a command line runs through, and the module that
 * builds the MCP server. The core's CLI exports `main(argv, env)`; the channels' export `run(argv, deps)`.
 *
 * `test/parity.test.mjs` fails when a package in `registries.mjs`'s `SURFACES` is missing here, so a new channel's
 * rows cannot go undriven.
 */
export const DRIVERS = Object.freeze({
  core: {
    cli: 'packages/core/src/cli.ts',
    run: 'main',
    server: 'packages/core/src/mcp/server.ts',
    factory: 'createCoreMcpServer',
  },
  gmail: {
    cli: 'packages/gmail/src/cli/program.ts',
    run: 'run',
    server: 'packages/gmail/src/mcp/server.ts',
    factory: 'createGmailMcpServer',
  },
  slack: {
    cli: 'packages/slack/src/cli/program.ts',
    run: 'run',
    server: 'packages/slack/src/mcp/server.ts',
    factory: 'createSlackMcpServer',
  },
});

/** Where a package's operations live. */
export const operationsDir = (pkg) => join(ROOT, 'packages', pkg, 'src', 'operations');

/** How many operations one drive may call before it is stopped: a loop over an inert value never ends by itself. */
const CALL_LIMIT = 200;
/** How long one command or tool may take to reach its operation. Nothing real runs, so this is generous. */
const DRIVE_TIMEOUT_MS = 15_000;
/** An approval id of the right shape that no approval has: a guard that reads the store finds nothing, and goes on. */
export const PLACEHOLDER_APPROVAL = `ap_${'0'.repeat(26)}`;

// ── Resolving a row's operation names ────────────────────────────────────────────────────────────────────────────

/** A row's `operation` (or another of its name fields, `via`), as a list: a composite command names several. */
export function operationNames(row, field = 'operation') {
  const value = row?.[field];
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name) : [];
}

/**
 * Which exported function a row's name means: `<package>:<name>`.
 *
 * Looked up in the row's own package first and then in the core's, because a channel's `mcp install` runs the core's
 * `serverInstallChange` (design §5). Never "either": `doctor` in a Gmail row is Gmail's `doctor`, so a row pairing
 * `agent-gmail doctor` with `comms_doctor` cannot pass on the core's function of the same name.
 *
 * `operations` is `{ package: { name: [module, …] } }`. Returns `{ id, module }`, or `{ problem }`.
 */
export function resolveOperation(operations, pkg, name) {
  for (const owner of pkg === 'core' ? ['core'] : [pkg, 'core']) {
    const modules = operations?.[owner]?.[name];
    if (!modules) continue;
    if (modules.length > 1) {
      return { problem: `"${name}" is exported by more than one module of ${owner}: ${modules.join(', ')}` };
    }
    return { id: `${owner}:${name}`, module: `${owner}'s ${modules[0]}` };
  }
  const where = pkg === 'core' ? 'packages/core/src/operations' : `packages/${pkg}/src/operations or the core's`;
  return { problem: `no module in ${where} exports a function called "${name}"` };
}

/**
 * The names of a function's parameters, read from its source, in order: what a row's `expect` names an argument by.
 *
 * The operations are TypeScript loaded with its types stripped to whitespace, so their source is the parameter list as
 * written. A parameter that is a destructuring pattern has no name, and is `null` here.
 */
export function parameterNames(fn) {
  const source = Function.prototype.toString.call(fn);
  const open = source.indexOf('(');
  const arrow = source.indexOf('=>');
  // `x => …`, with no parentheses to read.
  if (arrow !== -1 && (open === -1 || arrow < open)) {
    const single = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(source.trim());
    return single ? [single[1]] : [];
  }
  if (open === -1) return [];
  const pieces = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open + 1; at < source.length; at += 1) {
    const char = source[at];
    if (char === '"' || char === "'" || char === '`') {
      // A default value's string: skipped whole, so a bracket or a comma inside it counts for nothing.
      for (at += 1; at < source.length && source[at] !== char; at += 1) if (source[at] === '\\') at += 1;
    } else if (char === '/' && source[at + 1] === '/') {
      at = source.indexOf('\n', at);
      if (at === -1) break;
    } else if (char === '/' && source[at + 1] === '*') {
      at = source.indexOf('*/', at + 2) + 1;
      if (at === 0) break;
    } else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      if (depth === 0) {
        pieces.push(source.slice(start, at));
        break;
      }
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      pieces.push(source.slice(start, at));
      start = at + 1;
    }
  }
  return pieces
    .map((piece) => piece.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
    .filter((piece) => piece.trim() !== '') // the empty piece after a trailing comma
    .map((piece) => /^\s*(?:\.\.\.\s*)?([A-Za-z_$][\w$]*)/.exec(piece)?.[1] ?? null);
}

/** How deep into an argument its values are recorded: the parameter, and two keys into an object it is. */
const RECORD_DEPTH = 3;

/**
 * What an operation was called with, as `{ path: value }`: `wanted`, `request.channel`, `options.onlyMode`.
 *
 * Only what a table can name and compare is kept — strings, finite numbers, booleans, `null`, lists of those — found
 * in the arguments themselves and in plain objects within `RECORD_DEPTH`. A value that is not given is absent. A
 * context, a class instance, a function and a stand-in's inert value are left out: none of them is what tells one
 * row's call from another's.
 */
export function recordArguments(args, names) {
  const recorded = {};
  const leaf = (value) =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
  const visit = (value, path, depth) => {
    if (leaf(value)) {
      recorded[path] = value;
      return;
    }
    if (typeof value !== 'object' || value === null || depth >= RECORD_DEPTH) return;
    if (Array.isArray(value)) {
      if (value.every(leaf)) recorded[path] = [...value];
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    // Data properties only: a getter is code, and running it here could do work — or call a stand-in mid-drive.
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (property.enumerable && 'value' in property) visit(property.value, `${path}.${key}`, depth + 1);
    }
  };
  args.forEach((value, index) => {
    visit(value, names[index] ?? String(index), 1);
  });
  return recorded;
}

/** Every operation some row of `rows` names, resolved: what a drive stops at when it is not the row's own. */
export function namedOperations(rows, operations) {
  const named = new Map();
  for (const row of rows) {
    if (row?.status !== 'both' || row.unchecked !== undefined) continue;
    for (const name of operationNames(row)) {
      const resolved = resolveOperation(operations, row.package, name);
      if (!resolved.id) continue;
      if (!named.has(resolved.id)) named.set(resolved.id, []);
      named.get(resolved.id).push(row.id);
    }
  }
  return named;
}

// ── The parent: run the drive, read what it found ───────────────────────────────────────────────────────────────

/**
 * Drives every `both` row of `table` in a sealed child process working in `dir`: toward the operation it names, or —
 * a row that names none yet — to the end, so the check can say what its two sides share.
 *
 * Returns `{ operations, parameters, reports, fatal }`: every operation by package; the parameter names of each one a
 * row names; and per row `{ cli, mcp }` — what each side was run with, every operation it called in order, what the
 * row's own operation received (`received`, by operation, as `recordArguments` keeps it), and how it ended. `fatal` is
 * set when a drive hung, after which nothing else is driven.
 */
export async function driveOperations(table, { dir }) {
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const input = join(dir, 'drive-input.json');
  const output = join(dir, 'drive-output.json');
  await writeFile(input, JSON.stringify({ rows: table?.capabilities ?? [] }));
  // Nothing of the caller's environment but what starting Node needs: a token in it is not the drive's to see.
  const env = {
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    AGENT_COMMS_CONFIG_DIR: join(dir, 'config'),
    AGENT_COMMS_STATE_DIR: join(dir, 'state'),
    AGENT_COMMS_DATA_DIR: join(dir, 'data'),
    TMPDIR: dir,
    TEMP: dir,
    TMP: dir,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      fileURLToPath(SELF),
      '--drive',
      input,
      output,
    ],
    { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  const code = await new Promise((settle, fail) => {
    child.on('error', fail);
    child.on('close', settle);
  });
  let result;
  try {
    result = JSON.parse(await readFile(output, 'utf8'));
  } catch {
    throw new Error(`the operations drive exited ${code} without a result${stderr ? `:\n${stderr}` : ''}`);
  }
  return result;
}

// ── The child: seal, hook, drive ─────────────────────────────────────────────────────────────────────────────────

/** What a stand-in throws once a drive has what it came for. Surfaces catch it like any other error. */
class Reached extends Error {
  constructor(id) {
    super(`parity: the drive stopped at ${id}`);
    this.name = 'Reached';
  }
}

/**
 * No network, no child process, no listening socket, no worker thread, no real home: whatever a stand-in missed has
 * nowhere to go.
 *
 * A worker thread is refused because it starts with Node's own modules as they were, before any of this. The account's
 * home directory is answered with the temp HOME wherever Node reports it — `os.userInfo()` reads the account database,
 * not HOME, so it would otherwise name the real one. Exported so `test/parity.test.mjs` can seal a process of its own
 * and try each way out.
 */
export async function seal() {
  const [net, tls, http, https, dgram, dns, childProcess, workers, os, { syncBuiltinESMExports }] = await Promise.all([
    import('node:net'),
    import('node:tls'),
    import('node:http'),
    import('node:https'),
    import('node:dgram'),
    import('node:dns'),
    import('node:child_process'),
    import('node:worker_threads'),
    import('node:os'),
    import('node:module'),
  ]);
  const refuse = (what) =>
    function refused() {
      throw new Error(`the parity drive does not ${what}`);
    };
  dgram.default.createSocket = refuse('send datagrams');
  dgram.default.Socket.prototype.bind = refuse('send datagrams');
  dgram.default.Socket.prototype.send = refuse('send datagrams');
  dgram.default.Socket.prototype.connect = refuse('send datagrams');
  // Every lookup and resolve, by callback, by promise, and through a Resolver of either kind.
  for (const target of [
    dns.default,
    dns.default.promises,
    dns.default.Resolver.prototype,
    dns.default.promises.Resolver.prototype,
  ]) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (/^(lookup|lookupService|resolve\w*|reverse)$/.test(name) && typeof target[name] === 'function') {
        target[name] = refuse('look names up');
      }
    }
  }
  workers.default.Worker = refuse('start worker threads');
  const userInfo = os.default.userInfo;
  os.default.userInfo = function sealedUserInfo(options) {
    let info = {};
    try {
      info = userInfo.call(this, options);
    } catch {
      // An account with no entry in the database (some containers): nothing to answer but the home, which is ours.
    }
    const home = os.default.homedir();
    return { ...info, homedir: options?.encoding === 'buffer' ? Buffer.from(home) : home };
  };
  globalThis.fetch = async () => {
    throw new Error('the parity drive does not reach the network');
  };
  for (const module of [net.default, tls.default]) {
    module.connect = refuse('open connections');
    module.createConnection = refuse('open connections');
  }
  net.default.Socket.prototype.connect = refuse('open connections');
  net.default.Server.prototype.listen = refuse('listen on a port');
  for (const module of [http.default, https.default]) {
    module.request = refuse('make requests');
    module.get = refuse('make requests');
  }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess.default[name] = refuse('start processes');
  }
  syncBuiltinESMExports();
}

/**
 * Every function each package's operations modules export: `{ package: { name: [module] } }`, by module, and each
 * function itself by `<package>:<name>` (the first module's, when two export one name — which a row cannot name).
 */
async function indexOperations() {
  const operations = {};
  const modules = new Map();
  const functions = new Map();
  for (const pkg of Object.keys(DRIVERS)) {
    operations[pkg] = {};
    const dir = operationsDir(pkg);
    const files = (await readdir(dir)).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).sort();
    for (const file of files) {
      const url = pathToFileURL(join(dir, file)).href;
      const namespace = await import(url);
      const exported = Object.keys(namespace).filter((name) => typeof namespace[name] === 'function');
      const module = `operations/${file}`;
      modules.set(url, { pkg, functions: exported });
      for (const name of exported) {
        operations[pkg][name] = [...(operations[pkg][name] ?? []), module];
        if (!functions.has(`${pkg}:${name}`)) functions.set(`${pkg}:${name}`, namespace[name]);
      }
    }
  }
  return { operations, modules, functions };
}

/**
 * The core's operations that `@agentcomms/core` exports, by name: what a channel's surface can call through the
 * package rather than a relative path. Read by identity from the core's own index, so nothing is listed by hand.
 */
async function coreReexports(modules) {
  const index = await import(pathToFileURL(join(ROOT, 'packages', 'core', 'src', 'index.ts')).href);
  const names = [];
  for (const [url, entry] of modules) {
    if (entry.pkg !== 'core') continue;
    const namespace = await import(url);
    for (const name of entry.functions) if (index[name] === namespace[name]) names.push(name);
  }
  return names;
}

const MARK = 'agentcomms-parity-stand-in';
const PACKAGES = join(ROOT, 'packages');

/** A module a surface is made of: under `packages/<package>/src/`, and not an operation itself. */
function isSurfaceModule(url) {
  if (!url?.startsWith('file:') || url.includes(MARK)) return false;
  const parts = relative(PACKAGES, fileURLToPath(url)).split(sep);
  return parts.length > 2 && !parts[0].startsWith('..') && parts[1] === 'src' && parts[2] !== 'operations';
}

/** The stand-in module for one operations module (or the core package): the real one, with its functions wrapped. */
function standInSource(real, { pkg, names }) {
  const lines = [
    `import * as real from ${JSON.stringify(real)};`,
    `export * from ${JSON.stringify(real)};`,
    `const standIn = globalThis[Symbol.for('agentcomms.parity.stand-in')];`,
  ];
  for (const name of names) {
    lines.push(`export const ${name} = standIn(${JSON.stringify(pkg)}, ${JSON.stringify(name)}, real.${name});`);
  }
  return lines.join('\n');
}

/** Routes every import a surface makes of an operation to its stand-in, and refuses the keychain outright. */
async function installHooks(modules, reexports) {
  const { registerHooks } = await import('node:module');
  const standIns = new Map([...modules].map(([url, entry]) => [url, { pkg: entry.pkg, names: entry.functions }]));
  // The MCP client is a dependency of the packages, not of the root: resolved as a package's own server resolves it.
  const packageParent = pathToFileURL(join(ROOT, DRIVERS.gmail.server)).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@napi-rs/keyring' || specifier.startsWith('@napi-rs/keyring/')) {
        throw new Error('the parity drive does not open the system keychain');
      }
      if (context.parentURL === SELF && specifier.startsWith('@modelcontextprotocol/')) {
        return nextResolve(specifier, { ...context, parentURL: packageParent });
      }
      const resolved = nextResolve(specifier, context);
      if (!isSurfaceModule(context.parentURL)) return resolved;
      if (specifier === '@agentcomms/core' && !standIns.has(resolved.url)) {
        standIns.set(resolved.url, { pkg: 'core', names: reexports });
      }
      if (!standIns.has(resolved.url)) return resolved;
      return {
        ...resolved,
        url: `${resolved.url}${resolved.url.includes('?') ? '&' : '?'}${MARK}`,
        shortCircuit: true,
      };
    },
    load(url, context, nextLoad) {
      if (!url.endsWith(MARK)) return nextLoad(url, context);
      const real = url.slice(0, -(MARK.length + 1));
      return { format: 'module', source: standInSource(real, standIns.get(real)), shortCircuit: true };
    },
  });
}

/**
 * An inert value: what every stand-in returns. Any property is another inert value, calling or constructing it gives
 * one, it is not a promise (so `await` hands it straight back), iterates as empty, counts as `0`, and reads as `[]` —
 * the one text every parser here takes as "nothing", so a command that parses what a stand-in read (`organise-undo`
 * parsing its receipt) goes on to its operation rather than refusing the stand-in's text.
 */
function inert() {
  const handler = {
    get(_target, key) {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : '[]');
      if (key === Symbol.iterator) return function* empty() {};
      if (key === Symbol.asyncIterator) return async function* empty() {};
      if (key === 'toJSON') return () => null;
      if (key === 'length' || key === 'size') return 0;
      return value;
    },
    apply: () => value,
    construct: () => value,
    set: () => true,
    defineProperty: () => true,
    deleteProperty: () => true,
  };
  const value = new Proxy(function inertValue() {}, handler);
  return value;
}

/** The one drive under way: set around each command or tool call, read by every stand-in. */
let current = null;

function standIn(pkg, name, fn) {
  if (typeof fn !== 'function') return fn;
  const id = `${pkg}:${name}`;
  let names;
  const call = (args) => {
    const drive = current;
    // Outside a drive — building a server, listing its tools — nothing is being judged, and nothing runs either.
    if (!drive) return inert();
    if (drive.stopped) throw new Reached(drive.stopped);
    drive.calls.push(id);
    // What the row's own operation was asked, the first time: what tells one row's call from another's that shares it.
    if (drive.wanted.has(id) && !Object.hasOwn(drive.received, id)) {
      names ??= parameterNames(fn);
      drive.received[id] = recordArguments(args, names);
    }
    const stop =
      drive.foreign.has(id) ||
      (drive.wanted.has(id) && drive.wanted.size === new Set(drive.calls.filter((c) => drive.wanted.has(c))).size) ||
      drive.calls.length >= CALL_LIMIT;
    if (stop) {
      drive.stopped = id;
      throw new Reached(id);
    }
    return inert();
  };
  return new Proxy(fn, { apply: (_target, _this, args) => call(args), construct: (_target, args) => call(args) });
}

/** The first line of what a surface refused with, when it did not reach its operation — the author's clue. */
function refusalOf(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const error = parsed?.error ?? parsed?.structuredContent?.error;
      if (error?.message) return `${error.code ?? 'ERROR'}: ${error.message}`;
      // A call the SDK refused before the handler ran — its schema — says so only as text.
      const said = parsed?.isError ? parsed.content?.find((part) => part?.type === 'text')?.text : undefined;
      if (said) return String(said).slice(0, 300);
    } catch {
      /* not the envelope */
    }
  }
  const first = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return first ? first.slice(0, 300) : null;
}

/** Runs `body` as one drive toward `wanted`, stopping at anything in `foreign`. */
async function traced({ wanted, foreign }, body) {
  const drive = { wanted, foreign, calls: [], received: {}, stopped: null };
  current = drive;
  let timer;
  let text = '';
  let failure = null;
  try {
    text = await Promise.race([
      body(),
      new Promise((_settle, fail) => {
        timer = setTimeout(
          () => fail(new Error(`did not finish within ${DRIVE_TIMEOUT_MS / 1000}s`)),
          DRIVE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (!(error instanceof Reached)) failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  // Anything the surface left running settles against this drive, which has stopped, rather than the next one.
  await new Promise((settle) => setImmediate(settle));
  current = null;
  return {
    calls: drive.calls,
    received: drive.received,
    stopped: drive.stopped,
    timedOut: failure?.startsWith('did not finish') ?? false,
    refusal: failure ?? (drive.stopped ? null : refusalOf(text)),
  };
}

/** A value for an argument nobody said anything about, by its name: shaped so that guards before the call pass. */
function placeholder(name, pkg) {
  if (/approval/i.test(name)) return PLACEHOLDER_APPROVAL;
  if (/^(inbox|alias|workspace|account|from|to)$/i.test(name)) return `parity/${pkg === 'slack' ? 'slack' : 'gmail'}`;
  return 'parity';
}

/** The smallest arguments a tool's input schema accepts: every required property, with a value of its type. */
function sample(schema, name, pkg) {
  if (!schema || typeof schema !== 'object') return placeholder(name, pkg);
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) return sample(schema[key][0], name, pkg);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'integer':
    case 'number':
      return Math.max(1, schema.minimum ?? 1);
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () => sample(schema.items, name, pkg));
    case 'object':
      return Object.fromEntries(
        (schema.required ?? []).map((key) => [key, sample(schema.properties?.[key], key, pkg)]),
      );
    default:
      return placeholder(name, pkg);
  }
}

/**
 * A tool's arguments: its schema's required ones, the account it acts on (`inbox`, `workspace`, which the server
 * requires even where the schema cannot), and then the row's own `args` over the top.
 */
function toolArguments(tool, pkg, row) {
  const schema = tool.inputSchema ?? {};
  const args = sample({ ...schema, type: 'object' }, '', pkg);
  for (const key of ['inbox', 'workspace']) {
    if (schema.properties?.[key] && args[key] === undefined) args[key] = placeholder(key, pkg);
  }
  return { ...args, ...(row.args ?? {}) };
}

/** Captures what a surface writes to the process's own streams: the core's CLI writes there, not to injected ones. */
async function capturing(body) {
  const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
  let text = '';
  const take = (chunk, encoding, callback) => {
    text += String(chunk);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.stdout.write = take;
  process.stderr.write = take;
  try {
    await body();
  } finally {
    process.stdout.write = writes.stdout;
    process.stderr.write = writes.stderr;
  }
  return text;
}

async function drive(inputPath, outputPath) {
  await seal();
  // The file store, pinned, so nothing so much as asks which store to use.
  const configDir = process.env.AGENT_COMMS_CONFIG_DIR;
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);

  const { rows } = JSON.parse(await readFile(inputPath, 'utf8'));
  const { operations, modules, functions } = await indexOperations();
  const reexports = await coreReexports(modules);
  globalThis[Symbol.for('agentcomms.parity.stand-in')] = standIn;
  await installHooks(modules, reexports);

  const { PassThrough } = await import('node:stream');
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const blocked = async () => {
    throw new Error('the parity drive does not reach the network');
  };

  // ── The surfaces, loaded through the hooks ──
  const clis = {};
  const tools = new Map();
  // Built outside any drive, so a stand-in called while a server starts runs nothing and records nothing.
  for (const [pkg, driver] of Object.entries(DRIVERS)) {
    clis[pkg] = (await import(pathToFileURL(join(ROOT, driver.cli)).href))[driver.run];
    const factory = (await import(pathToFileURL(join(ROOT, driver.server)).href))[driver.factory];
    const built = await factory({ env: process.env, keyring: null, fetch: blocked, probe: blocked });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'agentcomms-parity', version: '0' });
    await Promise.all([built.server.connect(serverSide), client.connect(clientSide)]);
    for (const tool of (await client.listTools()).tools) tools.set(tool.name, { pkg, tool, client });
  }

  const runCli = (pkg, argv) =>
    capturing(async () => {
      const out = new PassThrough();
      const err = new PassThrough();
      let text = '';
      const collect = (chunk) => {
        text += chunk;
      };
      out.on('data', collect);
      err.on('data', collect);
      const stdin = new PassThrough();
      stdin.end();
      const streams = {
        stdout: Object.assign(out, { isTTY: false }),
        stderr: Object.assign(err, { isTTY: false }),
        stdin: Object.assign(stdin, { isTTY: false }),
      };
      if (pkg === 'core') await clis.core(argv, process.env);
      else {
        await clis[pkg](argv, {
          env: process.env,
          streams,
          openBrowser: () => undefined,
          probe: blocked,
          read: blocked,
          appConfig: blocked,
        });
      }
      // A stream hands its last chunk over on the next turn, not on the write that made it.
      await new Promise((settle) => setImmediate(settle));
      process.stdout.write(text);
    });

  const named = namedOperations(rows, operations);
  // What every operation a row names takes, so the check can say when an `expect` names an argument it does not.
  const parameters = Object.fromEntries([...named.keys()].map((id) => [id, parameterNames(functions.get(id))]));
  const reports = {};
  for (const row of rows) {
    if (row?.status !== 'both' || row.unchecked !== undefined || typeof row.cli !== 'string') continue;
    const resolved = operationNames(row).map((name) => resolveOperation(operations, row.package, name));
    // A name that means nothing has nothing to drive toward; the check says so without running anything.
    if (resolved.some((entry) => !entry.id)) continue;
    const wanted = new Set(resolved.map((entry) => entry.id));
    // What the row says a side passes through on its way — `setup` reads the state first — is not a stop.
    const via = new Set(
      operationNames(row, 'via').map((name) => resolveOperation(operations, row.package, name).id ?? ''),
    );
    // A row that names no operation yet stops nowhere, so the check can report everything its two sides call.
    const foreign = new Set(wanted.size === 0 ? [] : [...named.keys()].filter((id) => !wanted.has(id) && !via.has(id)));
    const report = {};

    // The command: its path, the row's own arguments, and whatever Commander says is still required.
    if (clis[row.package]) {
      const path = row.cli.split(' ');
      const positionals = [];
      const options = [];
      let outcome;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const argv = [...path, ...positionals, ...(row.argv ?? []), ...options, '--json'];
        outcome = { argv, ...(await traced({ wanted, foreign }, () => runCli(row.package, argv))) };
        if (outcome.calls.length > 0 || !outcome.refusal) break;
        const argument = /missing required argument '([^']+)'/.exec(outcome.refusal);
        const option = /required option '(-[^' ]+)(?: <([^>]+)>)?' not specified/.exec(outcome.refusal);
        if (argument) positionals.push(placeholder(argument[1], row.package));
        else if (option) options.push(option[1], placeholder(option[2] ?? option[1].replace(/^-+/, ''), row.package));
        else break;
      }
      report.cli = outcome;
    }

    // The tool: through a client, so the schema checks the call exactly as it checks an agent's.
    const served = typeof row.mcp === 'string' ? tools.get(row.mcp) : undefined;
    if (served) {
      const args = toolArguments(served.tool, served.pkg, row);
      report.mcp = {
        args,
        ...(await traced({ wanted, foreign }, async () =>
          JSON.stringify(await served.client.callTool({ name: row.mcp, arguments: args })),
        )),
      };
    }
    reports[row.id] = report;
    if (report.cli?.timedOut || report.mcp?.timedOut) {
      // Whatever is still running may call a stand-in during the next drive; nothing after this can be trusted.
      await writeFile(
        outputPath,
        JSON.stringify({ operations, parameters, reports, fatal: `row "${row.id}" did not finish` }),
      );
      process.exit(0);
    }
  }
  await writeFile(outputPath, JSON.stringify({ operations, parameters, reports }));
  // The servers and their clients hold the event loop open; everything they were for is written.
  process.exit(0);
}

// Compared through realpath, as `parity.mjs` compares itself: a temp directory can be a symlink (macOS `/tmp`).
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (process.argv[2] === '--drive' && invoked === realpathSync(fileURLToPath(SELF))) {
  await drive(process.argv[3], process.argv[4]);
}
