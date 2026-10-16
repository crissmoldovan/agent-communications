import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  argvOf,
  baseEnvironment,
  builtCli,
  commandEndingWith,
  commandsIn,
  environmentAssignments,
  FOUR_FOLDERS,
  filesUnder,
  freshShell,
  inWindowsShells,
  isCanonical,
  NEEDS_TERMINAL,
  ON_POSIX,
  ON_WINDOWS,
  PATH_OPTIONS,
  pinsOf,
  posixShell,
  posixShellAsync,
  posixTerminal,
  ROOT,
  real,
  runNode,
  sealAttempts,
  startMcpServer,
  strippedPath,
  suiteCommandsOn,
  suiteTraces,
  WRITES,
  windowsShells,
  wordsOf,
} from './helpers/real-shell.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/**
 * The acceptance criterion of 0.13.1, in real shells (CUE-403; design 2026-10-04 §1, §4 items 3 and 8).
 *
 * Every terminal handoff is a pasteable command that needs no suite command on PATH and pins every suite folder it
 * uses, or the exact words as JSON to type, or no command at all and why. These tests play both people: the process
 * that prints — this checkout's **built** core and Gmail, run as an installation runs them, with relative path options
 * from a working folder of its own — and the person who pastes, in a fresh shell (`helpers/real-shell.mjs`): no suite
 * command on PATH, `AGENT_COMMS_*`, XDG, the home and AppData all pointing at decoys, another working folder, and a
 * seal that refuses the keychain and every connection off the machine and writes each attempt down.
 *
 * A pasted command that found a folder from that environment instead of its pins would leave a trace in the decoys, or
 * miss the approval, the secret or the configuration the printing process made: every test looks for both. POSIX runs
 * here; the Windows cases run on the release run's windows-latest legs, through cmd.exe, Windows PowerShell and
 * PowerShell 7, and skip elsewhere — as core's renderer tests do. A person's own command, `approve`, needs a terminal:
 * on POSIX it gets a pseudo-terminal (`helpers/terminal.py`) and its code typed back; Windows has no such thing to give
 * it from a test, so there the approval it refuses for want of one is found recorded in the printing process's store.
 * Every folder and file a test makes goes through the fixtures' writes (`WRITES`), refused in the real home.
 */

const CORE = builtCli('core');
const GMAIL = builtCli('gmail');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'packages', 'core', 'package.json'), 'utf8')).version;

/** A client secret for the test profile: a made-up value, never a real credential. */
const FAKE_SECRET = 'fake-cue403-client-secret-not-real';

/**
 * The machine that prints: a home of its own, and the five suite folders pinned by **relative** options from its own
 * working folder, as a person might type them. `folders` are what the options resolve to: the canonical absolute
 * values a printed command must carry. The file secret store is chosen, so nothing reaches a keychain.
 */
async function machine(options = {}) {
  const root = real(await tempDir('agentcomms-real-shell-'));
  const home = join(root, 'print-home');
  const cwd = join(root, 'print-cwd');
  WRITES.mkdir(home, { recursive: true });
  WRITES.mkdir(cwd, { recursive: true });
  // Relative, and one of them not canonical: a printed command carries each resolved, without the `.` or the end `/`.
  const relative = options.relative ?? {
    configDir: join('pins', 'config'),
    stateDir: ['pins', '.', 'state', ''].join(sep),
    dataDir: join('pins', 'data'),
    secretsDir: join('pins', 'secrets'),
    downloadsDir: join('pins', 'downloads'),
  };
  const folders = Object.fromEntries(Object.entries(relative).map(([key, value]) => [key, resolve(cwd, value)]));
  const pinArgs = Object.entries(relative).flatMap(([key, value]) => [PATH_OPTIONS[key], value]);
  const tmp = join(root, 'print-tmp');
  WRITES.mkdir(tmp);
  const env = { ...baseEnvironment({ home, tmp, sealLog: join(root, 'print-seal.jsonl') }), ...(options.env ?? {}) };
  /*
   * This Node on the printing person's PATH, as a person's own would be, and nothing else: an installer registers the
   * `node` it finds there, and a system Node of another version in /usr/bin must not be the one a test registers. On
   * Windows the installer falls back to this process's Node, which is the same.
   */
  const nodeBin = join(root, 'node-bin');
  if (process.platform !== 'win32') {
    WRITES.mkdir(nodeBin);
    symlinkSync(process.execPath, join(nodeBin, 'node'));
    env.PATH = [nodeBin, env.PATH].join(':');
  }
  const { configDir } = folders;
  if (configDir !== undefined) {
    WRITES.mkdir(configDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
    WRITES.writeFile(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);
  }
  /** Runs a CLI of this checkout as the printing process: `cli` with the pins, then `args`. */
  const print = (args, cli = CORE) => runNode([cli, ...pinArgs, ...args], { env, cwd });
  return { root, home, cwd, env, folders, pinArgs, print, nodeBin, sealLog: env.AGENTCOMMS_TEST_SEAL_LOG };
}

/** The JSON envelope a `--json` run printed first. */
function envelope(result) {
  const line = String(result.stdout)
    .split('\n')
    .find((each) => each.startsWith('{'));
  assert.ok(line, `no JSON in:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line);
}

/** A change prepared and held for approval: its id and the hint that names what to run. */
function held(result) {
  assert.equal(result.status, 10, `exit ${result.status}:\n${result.stdout}\n${result.stderr}`);
  const { error } = envelope(result);
  assert.equal(error.code, 'APPROVAL_PENDING', JSON.stringify(error));
  return { id: error.details.approvalId, hint: error.hint };
}

/**
 * This Node as a process with `env` names it in a command it prints (CUE-492): the first `node` on that PATH that is
 * the same real file as this Node, as PATH spells it — the printing machine's `node-bin/node` link stays the link — and
 * otherwise `process.execPath`; with no environment (`null`, a command located in this process with none), nothing is
 * looked for. Worked out here, not asked of core, so a test of a command's program checks core's choice.
 */
function printedNode(env) {
  const own = process.execPath;
  if (env === null) return own;
  const windows = process.platform === 'win32';
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  let real;
  try {
    real = realpathSync(own);
  } catch {
    return own;
  }
  const names = windows
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT')
        .split(';')
        .filter(Boolean)
        .map((extension) => `node${extension.toLowerCase()}`)
    : ['node'];
  const folders = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter((folder) => (windows ? /^[A-Za-z]:[\\/]/.test(folder) : folder !== '' && isAbsolute(folder)));
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        if (!same(realpathSync(candidate), real)) continue;
        return same(candidate, own) ? own : candidate;
      } catch {
        // not here, or not runnable: keep looking
      }
    }
  }
  return own;
}

/**
 * Checks a printed command is the acceptance criterion's first outcome: this Node, as the PATH of the process that
 * printed it (`printedWith`, its environment) finds it, `entry`, then exactly one canonical absolute option for each
 * folder in `uses` with the printing process's value — and no other path option — then `tail`. Returns its words.
 */
function assertLocated(
  command,
  { entry, folders, uses = FOUR_FOLDERS, tail, printedWith, platform = process.platform },
) {
  assert.ok(printedWith !== undefined, 'say which environment printed the command, or null for none');
  const words = wordsOf(command, platform);
  assert.ok(words !== null, `a line to paste, not the JSON form: ${command}`);
  assert.equal(
    words[0],
    printedNode(printedWith),
    `the program is this Node, as the printer's PATH finds it: ${command}`,
  );
  assert.equal(words[1], entry, `it runs the installation's own entry: ${command}`);
  const pins = pinsOf(words);
  assert.deepEqual(
    Object.keys(pins).sort(),
    [...uses].sort(),
    `exactly the folders the command uses are pinned: ${command}`,
  );
  for (const key of uses) {
    assert.equal(pins[key], folders[key], `${PATH_OPTIONS[key]} is the printing process's: ${command}`);
    assert.ok(isCanonical(pins[key]), `${PATH_OPTIONS[key]} is canonical and absolute: ${command}`);
  }
  assert.equal(words.length, 2 + uses.length * 2 + tail.length, `nothing else in it: ${command}`);
  assert.deepEqual(words.slice(-tail.length), tail, command);
  return words;
}

/** A fresh shell, its PATH checked to hold no suite command, under `root`. */
function shellUnder(root, name, extra) {
  const shell = freshShell(join(root, name), extra === undefined ? {} : { extra });
  assert.deepEqual(suiteCommandsOn(shell.env.PATH), [], 'no suite command on the fresh shell’s PATH');
  return shell;
}

/** Nothing reached a keychain or left the machine from the processes of `shell`, and no decoy was used. */
function assertClean(shell, expected = []) {
  assert.deepEqual(sealAttempts(shell.sealLog), [], 'no keychain, no provider, no connection off the machine');
  assert.deepEqual(suiteTraces(shell, expected), [], 'no suite folder found from the shell’s environment');
}

/** The configuration a printing machine keeps in its pinned folder. */
function configOf(m) {
  return JSON.parse(readFileSync(join(m.folders.configDir, 'config.json'), 'utf8'));
}

/** Every audit record in a state folder. */
function audit(stateDir) {
  const dir = join(stateDir, 'audit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── 3b, 3g, 8a, 8c, 8d: a change prepared at the CLI ─────────────────────────────────────────────────────────────

test('a change prepared at the CLI is approved at a fresh terminal and run again from a fresh shell, with nothing of the suite on PATH (3b, 3g, 8a, 8c, 8d)', {
  ...ON_POSIX,
  ...NEEDS_TERMINAL,
}, async () => {
  const m = await machine();
  assert.equal(m.print(['policy', 'confirm']).status, 0);
  const allowed = join(m.root, 'allowed');
  WRITES.mkdir(allowed);

  // The human form and the JSON form name the same commands, and neither assigns an environment variable.
  const human = m.print(['attach', 'roots', 'add', allowed]);
  assert.equal(human.status, 10, human.stderr);
  assert.deepEqual(environmentAssignments(`${human.stdout}${human.stderr}`), []);
  const prepared = m.print(['attach', 'roots', 'add', allowed, '--json']);
  const { id, hint } = held(prepared);
  assert.deepEqual(environmentAssignments(prepared.stdout), []);

  // The printing process pinned downloads too; neither command opens them, so neither carries them (D2).
  const approve = commandEndingWith(hint, ['approve', id]);
  assertLocated(approve, { entry: CORE, folders: m.folders, tail: ['approve', id], printedWith: m.env });
  const rerun = commandEndingWith(hint, ['attach', 'roots', 'add', allowed, '--approval', id]);
  assertLocated(rerun, {
    entry: CORE,
    folders: m.folders,
    tail: ['attach', 'roots', 'add', allowed, '--approval', id],
    printedWith: m.env,
  });

  // And the wait that learns when they have (design 2026-10-05 §D7, D7-b): core's own, pinned as the approve is.
  const wait = commandEndingWith(hint, ['approval', 'wait', id]);
  assertLocated(wait, { entry: CORE, folders: m.folders, tail: ['approval', 'wait', id], printedWith: m.env });

  // The person, at a terminal of their own: the approval is in the printing process's store, and they approve it —
  // while the agent, in a shell of its own, waits as it was told, and sees them do it.
  const person = shellUnder(m.root, 'person');
  const watcher = shellUnder(m.root, 'watcher');
  const waiting = posixShellAsync(wait, watcher);
  const approved = posixTerminal(approve, person);
  assert.equal(approved.status, 0, approved.stdout);
  assert.match(approved.stdout, /Approved\./);
  assertClean(person);
  const waited = await waiting;
  assert.equal(waited.status, 0, `${waited.stdout}\n${waited.stderr}`);
  assert.match(waited.stdout, new RegExp(`^${id}: approved, and can be used now`, 'm'));
  assertClean(watcher);

  // The agent, in another fresh shell, runs the change again: it lands in the printing process's configuration.
  const agent = shellUnder(m.root, 'agent');
  const applied = posixShell(rerun, agent);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.ok(configOf(m).defaults.attachRoots.includes(allowed), JSON.stringify(configOf(m).defaults));
  assertClean(agent);
  assert.deepEqual(sealAttempts(m.sealLog), [], 'the printing process reached nothing either');
});

test(
  'on Windows a change prepared at the CLI runs again from cmd.exe and both PowerShells, and its approval is the printing store’s (3b, 8a, 8c)',
  ON_WINDOWS,
  async () => {
    const m = await machine();
    const person = shellUnder(m.root, 'person');
    let runs = 0;
    for (const each of windowsShells()) {
      // Under `chat` the agent runs the change again with the approval once the person has said yes in the chat.
      const allowed = join(m.root, `allowed-${runs}`);
      WRITES.mkdir(allowed);
      const { id, hint } = held(m.print(['attach', 'roots', 'add', allowed, '--json']));
      assert.deepEqual(environmentAssignments(hint), []);
      const rerun = commandEndingWith(hint, ['attach', 'roots', 'add', allowed, '--approval', id], 'win32');
      const words = wordsOf(rerun, 'win32');
      if (words !== null) {
        assert.deepEqual(pinsOf(words), {
          configDir: m.folders.configDir,
          stateDir: m.folders.stateDir,
          dataDir: m.folders.dataDir,
          secretsDir: m.folders.secretsDir,
        });
      }
      inWindowsShells(
        rerun,
        person,
        (result, name) => assert.equal(result.status, 0, `${name}: ${rerun}\n${result.stdout}\n${result.stderr}`),
        [each],
      );
      assert.ok(configOf(m).defaults.attachRoots.includes(allowed), each.name);
      runs += 1;
    }
    assert.ok(runs >= 2, 'cmd.exe and Windows PowerShell at the least');

    // `approve` is a person's command and needs a terminal, which no shell started here has: it refuses, and the
    // refusal is recorded against the approval in the printing process's own store, under its own policy.
    assert.equal(m.print(['policy', 'confirm']).status, 0);
    const allowed = join(m.root, 'allowed-confirm');
    WRITES.mkdir(allowed);
    const { id, hint } = held(m.print(['attach', 'roots', 'add', allowed, '--json']));
    const approve = commandEndingWith(hint, ['approve', id], 'win32');
    inWindowsShells(approve, person, (result, name) => {
      assert.equal(result.status, 10, `${name}: ${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /needs an interactive terminal/, name);
    });
    // The wait named beside it (D7-b): withdrawn from the printing store, the approval is found there, revoked, by the
    // wait pasted in each shell — as only its pins could find it.
    const wait = commandEndingWith(hint, ['approval', 'wait', id], 'win32');
    assert.equal(m.print(['approvals', 'revoke', id]).status, 0);
    inWindowsShells(wait, person, (result, name) => {
      assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^${id}: revoked`, 'm'), name);
    });
    const refused = audit(m.folders.stateDir).filter(
      (record) => record.approvalId === id && record.operation === 'change.approve' && record.outcome === 'refused',
    );
    assert.ok(refused.length >= 1, 'each refusal is in the printing process’s audit');
    assert.ok(
      refused.every((record) => record.policy === 'confirm'),
      'read from its approval record there',
    );
    assertClean(person);
  },
);

// ── 8a, 8c: a change prepared through the MCP server ─────────────────────────────────────────────────────────────

/** The four pins a registration carries, as the installer writes them: the printing machine's own folders. */
function registeredArgs(folders) {
  return FOUR_FOLDERS.flatMap((key) => [PATH_OPTIONS[key], folders[key]]);
}

test('a change prepared through the core server is approved at a fresh terminal, and the server applies it in the same store (8a, 8c, 8d)', {
  ...ON_POSIX,
  ...NEEDS_TERMINAL,
}, async (t) => {
  const m = await machine();
  assert.equal(m.print(['policy', 'confirm']).status, 0);
  const server = startMcpServer(process.execPath, [CORE, ...registeredArgs(m.folders), 'mcp'], {
    env: m.env,
    cwd: m.cwd,
  });
  t.after(() => server.close());
  const allowed = join(m.root, 'allowed-by-mcp');
  WRITES.mkdir(allowed);

  const asked = await server.call('comms_attach', { rootsAdd: allowed });
  assert.equal(asked.approvalRequired, true, JSON.stringify(asked));
  const approve = commandEndingWith(asked.next, ['approve', asked.approvalId]);
  assertLocated(approve, {
    entry: CORE,
    folders: m.folders,
    tail: ['approve', asked.approvalId],
    printedWith: m.env,
  });
  assert.deepEqual(environmentAssignments(asked.next), []);
  // The wait it names is a tool of the server that named it (D7-b).
  assert.match(asked.next, /; learn when they have with comms_approval_wait\./);

  const person = shellUnder(m.root, 'person');
  const approved = posixTerminal(approve, person);
  assert.equal(approved.status, 0, approved.stdout);
  assert.match(approved.stdout, /Approved\./);
  const waited = await server.call('comms_approval_wait', { approvalId: asked.approvalId, waitSeconds: 0 });
  assert.deepEqual([waited.state, waited.claimable], ['approved', true], JSON.stringify(waited));

  const applied = await server.call('comms_attach', { rootsAdd: allowed, approvalId: asked.approvalId });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.ok(configOf(m).defaults.attachRoots.includes(allowed));
  assertClean(person);
  assert.deepEqual(sealAttempts(m.sealLog), []);
});

// ── 3b, 3c: a handoff that reads a secret ────────────────────────────────────────────────────────────────────────

/** An organisation profile with a Google client whose secret goes to the file store: made up, never a real one. */
function writeProfile(dir) {
  const path = join(dir, 'acme.agentcomms.json');
  WRITES.writeFile(
    path,
    `${JSON.stringify({
      agentcomms: 'organisation-profile',
      version: 1,
      organisation: 'acme',
      label: 'Acme Test Org',
      gmail: {
        clientId: '000000000000-cue403.apps.googleusercontent.com',
        clientSecret: FAKE_SECRET,
        projectId: 'acme-agent-comms',
        serves: 'any',
      },
    })}\n`,
  );
  return path;
}

test(
  'a pasted handoff that reads a secret reads it from the printing process’s secrets folder, whatever the shell says (3b)',
  ON_POSIX,
  async () => {
    const m = await machine();
    const profile = writeProfile(m.root);
    // Under `chat` the profile is added by running the change again with its approval, from a fresh shell.
    const { id, hint } = held(m.print(['org', 'add', profile, '--store', 'file', '--json']));
    const add = commandEndingWith(hint, ['org', 'add', profile, '--store', 'file', '--approval', id]);
    assertLocated(add, {
      entry: CORE,
      folders: m.folders,
      tail: ['org', 'add', profile, '--store', 'file', '--approval', id],
      printedWith: m.env,
    });
    const first = shellUnder(m.root, 'first');
    const added = posixShell(add, first);
    assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
    assertClean(first);

    // Adding it again hands over `org update`, which reads the client's secret back from the store.
    const again = m.print(['org', 'add', profile, '--store', 'file']);
    const update = commandEndingWith(again.stderr, ['org', 'update', 'acme']);
    assertLocated(update, { entry: CORE, folders: m.folders, tail: ['org', 'update', 'acme'], printedWith: m.env });
    const second = shellUnder(m.root, 'second');
    const read = posixShell(update, second);
    assert.equal(read.status, 0, `${read.stdout}\n${read.stderr}`);
    // Found where the printing process put it: nothing to repair. From any other folder it would rewrite the secret.
    assert.match(read.stdout, /Nothing to change: acme matches its profile\./);
    assertClean(second);
  },
);

test(
  'on Windows, with roaming and local AppData apart and --config-dir given, a pasted handoff reads the printing process’s secrets folder (3c)',
  ON_WINDOWS,
  async () => {
    const root = real(await tempDir('agentcomms-real-shell-split-'));
    const appData = join(root, 'Roaming');
    const localAppData = join(root, 'Local');
    // Only the configuration is pinned: the rest are derived from the split roots, and the secrets folder from the
    // local one. An AGENT_COMMS_CONFIG_DIR would have moved it beside the configuration; an option does not (D2).
    const m = await machine({
      relative: { configDir: 'pinned-config' },
      env: { APPDATA: appData, LOCALAPPDATA: localAppData },
    });
    const local = join(localAppData, 'agent-communications');
    const folders = {
      configDir: m.folders.configDir,
      stateDir: join(local, 'state'),
      dataDir: local,
      secretsDir: join(local, 'secrets'),
    };
    const profile = writeProfile(m.root);
    const { id, hint } = held(m.print(['org', 'add', profile, '--store', 'file', '--json']));
    const add = commandEndingWith(hint, ['org', 'add', profile, '--store', 'file', '--approval', id], 'win32');
    const addWords = wordsOf(add, 'win32');
    if (addWords !== null) {
      assert.deepEqual(pinsOf(addWords), folders);
      assert.notEqual(pinsOf(addWords).secretsDir, join(m.folders.configDir, 'secrets'));
    }
    const shell = shellUnder(m.root, 'shell');
    inWindowsShells(add, shell, (result, name) => {
      // The first shell adds it; the profile is then already there.
      assert.ok(result.status === 0 || /already been added/.test(result.stderr), `${name}: ${result.stderr}`);
    });
    const again = m.print(['org', 'add', profile, '--store', 'file']);
    const update = commandEndingWith(again.stderr, ['org', 'update', 'acme'], 'win32');
    inWindowsShells(update, shell, (result, name) => {
      assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Nothing to change: acme matches its profile\./, name);
    });
    assertClean(shell);
  },
);

/**
 * A registration of `name` with a client in `home` — cursor, or Gemini's settings — written before 0.13.1: `entry`,
 * then `mcp`, and no pins. Doctor offers to register it again.
 */
function legacyRegistration(home, name, entry, client = 'cursor') {
  const file = client === 'gemini' ? join(home, '.gemini', 'settings.json') : join(home, '.cursor', 'mcp.json');
  WRITES.mkdir(dirname(file), { recursive: true });
  WRITES.writeFile(
    file,
    JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [entry, 'mcp'] } } }),
  );
}

// ── 3e: the folders each kind of command declares ────────────────────────────────────────────────────────────────

/** A stale managed runtime of core, as the managed launcher lays one out: what `mcp prune` offers to remove. */
function staleRuntime(dataDir, version) {
  const root = join(dataDir, 'runtime', `${version}-core`);
  const pkg = join(root, 'node_modules', '@agentcomms', 'core');
  WRITES.mkdir(join(pkg, 'dist'), { recursive: true });
  WRITES.writeFile(
    join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { '@agentcomms/core': version } }),
  );
  WRITES.writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@agentcomms/core', version }));
  WRITES.writeFile(join(pkg, 'dist', 'cli.mjs'), '');
  return root;
}

test('every kind of command a handoff names pins exactly the folders it declares, and runs from a fresh shell on those alone (3e)', async () => {
  /*
   * The table is the declarations, kind by kind: what the product printed, and the folders the command it names is
   * pinned to. Each command is then run from a fresh shell whose environment names other folders for everything: one
   * that opened a folder it did not declare would find it there, and leave a trace in the decoys.
   */
  const m = await machine();
  const profile = writeProfile(m.root);
  staleRuntime(m.folders.dataDir, '0.0.1');
  const platform = process.platform;
  const rows = [];
  /** Checks a row's command carries exactly its folders, then runs it from a fresh shell on those alone. */
  function run(row) {
    if (platform !== 'win32') {
      assertLocated(row.command, {
        entry: row.entry,
        folders: m.folders,
        uses: row.uses,
        tail: row.tail,
        printedWith: row.printedWith,
      });
    } else {
      const words = wordsOf(row.command, 'win32');
      if (words !== null) assert.deepEqual(Object.keys(pinsOf(words)).sort(), [...row.uses].sort(), row.kind);
    }
    assert.ok(!row.uses.includes('downloadsDir'), `${row.kind} opens no downloads, so it is not pinned to them`);
    /*
     * A registration's approval is bound to what it does outside the configuration — which client file, started with
     * which `node` — and those are the person's: found from their home and PATH (D2, 3f). So it is run again with the
     * printing person's home and PATH, which hold no suite command; every suite variable is still a decoy.
     */
    const own = row.kind === 'install' ? { HOME: m.home, USERPROFILE: m.home, PATH: m.env.PATH } : undefined;
    const shell = shellUnder(m.root, `run-${row.kind}`, own);
    const check = (result, name) => {
      const said = `${result.stdout}${result.stderr}`;
      // `approve` is a person's, and refuses without a terminal — after reading its approval from the declared state.
      if (row.kind === 'approvals') assert.match(said, /needs an interactive terminal/, `${row.kind}, ${name}`);
      else if (row.kind === 'doctor') assert.match(said, /needs approval first/, `${row.kind}: ${said}`);
      else assert.equal(result.status, 0, `${row.kind}, ${name}: ${said}`);
    };
    if (platform === 'win32') {
      // One shell a row, in turn: a change run again consumes its approval, so it runs once.
      const shells = windowsShells();
      inWindowsShells(row.command, shell, check, [shells[rows.indexOf(row) % shells.length]]);
    } else check(posixShell(row.command, shell), 'sh');
    assertClean(shell);
  }
  // Each row is run as soon as it is printed, as the person told to run it would. Every row but `channels` is printed by
  // the machine, with its environment.
  const add = (kind, command, tail, uses, entry = CORE, printedWith = m.env) => {
    rows.push({ kind, command, tail, uses, entry, printedWith });
    run(rows.at(-1));
  };

  let held_ = held(m.print(['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--no-verify', '--json']));
  const installTail = ['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--no-verify'];
  add(
    'install',
    commandEndingWith(held_.hint, [...installTail, '--approval', held_.id], platform),
    [...installTail, '--approval', held_.id],
    FOUR_FOLDERS,
  );

  if (platform === 'win32') {
    /*
     * Windows has no `ps`, and prune deletes nothing it cannot show unused: it lists the runtime as not checked, says
     * why, and changes nothing — so there is no change to approve and no handoff to run (mcp-install.ts,
     * `runningCommandLines`).
     */
    const pruned = m.print(['mcp', 'prune', '--json']);
    assert.equal(pruned.status, 0, pruned.stdout);
    const { data } = envelope(pruned);
    assert.match(data.refused, /running processes on this machine could not be listed/);
    assert.deepEqual(data.removed, []);
    assert.deepEqual(commandsIn(pruned.stdout), [], 'no command when nothing is to be approved');
  } else {
    held_ = held(m.print(['mcp', 'prune', '--json']));
    add(
      'prune',
      commandEndingWith(held_.hint, ['mcp', 'prune', '--approval', held_.id], platform),
      ['mcp', 'prune', '--approval', held_.id],
      FOUR_FOLDERS,
    );
  }

  held_ = held(m.print(['update', '--later', '--json']));
  add(
    'update',
    commandEndingWith(held_.hint, ['update', '--later', '--approval', held_.id], platform),
    ['update', '--later', '--approval', held_.id],
    FOUR_FOLDERS,
  );

  // A registration from before 0.13.1 — no pins — which doctor offers to register again.
  // Gemini's, so that the cursor registration printed above is still the one its approval was for when it runs.
  legacyRegistration(m.home, 'agentcomms', CORE, 'gemini');
  const doctor = envelope(m.print(['doctor', '--json']));
  const repair = doctor.data.checks.find((check) => check.name === 'core server');
  assert.ok(repair?.fix, JSON.stringify(doctor.data.checks));
  const reRegister = ['mcp', 'install', '--client', 'gemini', '--launcher', 'local', '--force'];
  add('doctor', commandEndingWith(repair.fix, reRegister, platform), reRegister, FOUR_FOLDERS);

  // Gmail's setup, from a machine with no Google client yet, hands over itself for a terminal with a person at it.
  const setup = m.print(['setup'], GMAIL);
  add('setup', commandEndingWith(setup.stdout, ['setup'], platform), ['setup'], FOUR_FOLDERS, GMAIL);

  const added = held(m.print(['org', 'add', profile, '--store', 'file', '--json']));
  const addTail = ['org', 'add', profile, '--store', 'file', '--approval', added.id];
  assert.equal(runNode(argvOf(commandEndingWith(added.hint, addTail, platform), platform).slice(1), m).status, 0);
  const again = m.print(['org', 'add', profile, '--store', 'file']);
  add(
    'secrets',
    commandEndingWith(again.stderr, ['org', 'update', 'acme'], platform),
    ['org', 'update', 'acme'],
    FOUR_FOLDERS,
  );

  const usage = m.print(['no-such-command']);
  add('help', commandEndingWith(usage.stderr, ['--help'], platform), ['--help'], []);

  // `channels` is named by no handoff today; the locator gives it what every command gets unless it says otherwise.
  const library = pathToFileURL(join(ROOT, 'packages', 'core', 'dist', 'index.mjs')).href;
  const { cliHandoffs, handoffText } = await import(library);
  const handoffs = cliHandoffs({
    caller: { url: library, packageName: '@agentcomms/core' },
    paths: m.folders,
    platform,
  });
  // Located here, with no environment: nothing on a PATH is looked for.
  add('channels', handoffText(handoffs.own(['channels'])), ['channels'], FOUR_FOLDERS, CORE, null);

  // Approvals: a person's `approve`, under `confirm` — set once the changes above, approved in the chat, have run.
  assert.equal(m.print(['policy', 'confirm']).status, 0);
  const allowed = join(m.root, 'allowed');
  WRITES.mkdir(allowed);
  held_ = held(m.print(['attach', 'roots', 'add', allowed, '--json']));
  add('approvals', commandEndingWith(held_.hint, ['approve', held_.id], platform), ['approve', held_.id], FOUR_FOLDERS);

  assert.deepEqual(
    rows.map((row) => row.kind),
    [
      'install',
      ...(platform === 'win32' ? [] : ['prune']),
      'update',
      'doctor',
      'setup',
      'secrets',
      'help',
      'channels',
      'approvals',
    ],
  );
  assert.ok(
    JSON.parse(readFileSync(join(m.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.agentcomms,
    'the registration is in the person’s own client',
  );
  assert.equal(
    existsSync(join(m.folders.dataDir, 'runtime', '0.0.1-core')),
    platform === 'win32',
    'prune removed the declared data’s runtime, where it can list what is running',
  );
  assert.ok(
    filesUnder(m.folders.stateDir).some((file) => /update/.test(file)),
    `update --later is in the declared state: ${filesUnder(m.folders.stateDir)}`,
  );
});

// ── 3f: the person's own MCP clients ─────────────────────────────────────────────────────────────────────────────

test('a registration pasted into a fresh shell goes to the clients of the person running it, with the printing process’s folders (3f)', async () => {
  /*
   * Client files are found from the environment of whoever runs the command, by design (D2): the pins fix only the
   * suite's own folders. So the person who pastes doctor's repair registers the server with their own clients —
   * found from their HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and, on Windows, APPDATA — on the printing process's folders.
   */
  const m = await machine();
  legacyRegistration(m.home, 'agentcomms', CORE);
  const checks = envelope(m.print(['doctor', '--json'])).data.checks;
  const repair = checks.find((check) => check.name === 'core server');
  assert.ok(repair?.fix, `doctor reads the printing person's own clients: ${JSON.stringify(checks)}`);
  const tail = ['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--force'];
  const command = commandEndingWith(repair.fix, tail);

  // The person running it keeps Claude Code, codex and the AppData clients somewhere of their own.
  const root = join(m.root, 'person');
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  const appData = join(root, 'appdata');
  WRITES.mkdir(claude, { recursive: true });
  WRITES.mkdir(codex, { recursive: true });
  WRITES.mkdir(join(appData, 'Code', 'User'), { recursive: true });
  WRITES.writeFile(
    join(claude, '.claude.json'),
    JSON.stringify({ mcpServers: { 'claude-gmail': { command: process.execPath, args: [GMAIL, 'mcp'] } } }),
  );
  WRITES.writeFile(
    join(codex, 'config.toml'),
    `[mcp_servers.codex-gmail]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(GMAIL)}, "mcp"]\n`,
  );
  WRITES.writeFile(
    join(appData, 'Code', 'User', 'mcp.json'),
    JSON.stringify({
      servers: { 'appdata-gmail': { type: 'stdio', command: process.execPath, args: [GMAIL, 'mcp'] } },
    }),
  );
  const shell = shellUnder(root, 'shell', { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, APPDATA: appData });
  const run = (line) => {
    if (process.platform !== 'win32') return posixShell(line, shell);
    const [first] = windowsShells();
    return first.run(line, { env: shell.env, cwd: shell.cwd });
  };

  // The repair, pasted: a registration is a change, shown first; the person says yes, and it is run again.
  const asked = run(command);
  assert.equal(asked.status, 10, `${asked.stdout}\n${asked.stderr}`);
  assert.match(asked.stdout, /~[\\/]\.cursor[\\/]mcp\.json/, 'the preview names the person’s own client file');
  const id = /approval (ap_[0-9A-Z]+)/.exec(asked.stdout)?.[1];
  const rerun = commandEndingWith(asked.stderr, [...tail, '--approval', id]);
  if (process.platform !== 'win32') {
    // Printed by the pasted command, run in the person's shell: this Node as that shell's PATH finds it.
    assertLocated(rerun, {
      entry: CORE,
      folders: m.folders,
      tail: [...tail, '--approval', id],
      printedWith: shell.env,
    });
  }
  const installed = run(rerun);
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

  // Written to the cursor configuration of the home the shell has, never the printing person's.
  const cursor = JSON.parse(readFileSync(join(shell.env.HOME, '.cursor', 'mcp.json'), 'utf8'));
  const entry = cursor.mcpServers.agentcomms;
  assert.ok(entry, JSON.stringify(cursor));
  assert.deepEqual(
    pinsOf(entry.args),
    Object.fromEntries(FOUR_FOLDERS.map((key) => [key, m.folders[key]])),
    'its suite folders are the printing process’s',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(m.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.agentcomms.args,
    [CORE, 'mcp'],
    'the printing person’s own entry is as it was',
  );

  // The same installation, with all five folders pinned, reads the shell's clients, and reports the pinned folders.
  const program = argvOf(command).slice(0, 2 + FOUR_FOLDERS.length * 2);
  const all = [...program, PATH_OPTIONS.downloadsDir, m.folders.downloadsDir];
  const asLine = (extra) =>
    [...all, ...extra]
      .map((word) => (process.platform === 'win32' ? word : `'${word.replaceAll("'", "'\\''")}'`))
      .join(' ');
  const channels = run(asLine(['channels', '--json']));
  assert.equal(channels.status, 0, channels.stderr);
  const seen = envelope(channels).data.channels.flatMap((channel) =>
    channel.registered.map((each) => `${each.client}:${each.name}`),
  );
  assert.ok(seen.includes('cursor:agentcomms'), seen.join(', '));
  assert.ok(seen.includes('claude-code:claude-gmail'), `CLAUDE_CONFIG_DIR at run time: ${seen.join(', ')}`);
  assert.ok(seen.includes('codex:codex-gmail'), `CODEX_HOME at run time: ${seen.join(', ')}`);
  assert.equal(
    seen.includes('vscode:appdata-gmail'),
    process.platform === 'win32',
    `APPDATA holds the VS Code client on Windows only: ${seen.join(', ')}`,
  );
  const paths = envelope(run(asLine(['paths', '--json']))).data;
  for (const key of [...FOUR_FOLDERS, 'downloadsDir']) assert.equal(paths[key], m.folders[key], key);
  assertClean(shell, ['home/.cursor/mcp.json']);
});

// ── 3j: installer-written registrations ──────────────────────────────────────────────────────────────────────────

/** A managed runtime of this release of core, as `npm install` would leave it: the package linked from the checkout. */
function managedRuntime(dataDir) {
  const root = join(dataDir, 'runtime', `${VERSION}-core`);
  WRITES.mkdir(join(root, 'node_modules', '@agentcomms'), { recursive: true });
  WRITES.writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'agentcomms-runtime', private: true, dependencies: { '@agentcomms/core': VERSION } }),
  );
  symlinkSync(
    join(ROOT, 'packages', 'core'),
    join(root, 'node_modules', '@agentcomms', 'core'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

/**
 * An `npx` that runs this checkout's built core for exactly `@agentcomms/core@<this version>`, and refuses anything
 * else: the registry is not reached from a test, and what is under test is the entry the installer wrote.
 */
function fakeNpx(dir) {
  WRITES.mkdir(dir, { recursive: true });
  const script = join(dir, 'fake-npx.mjs');
  WRITES.writeFile(
    script,
    [
      "import { spawnSync } from 'node:child_process';",
      'const [yes, spec, ...rest] = process.argv.slice(2);',
      `const wanted = ${JSON.stringify(`@agentcomms/core@${VERSION}`)};`,
      "if (yes !== '-y' || spec !== wanted) {",
      "  process.stderr.write('this npx runs only ' + wanted + ', not ' + spec + '\\n');",
      '  process.exit(64);',
      '}',
      `const run = spawnSync(process.execPath, [${JSON.stringify(CORE)}, ...rest], { stdio: 'inherit' });`,
      'process.exit(run.status ?? 1);',
      '',
    ].join('\n'),
  );
  if (process.platform === 'win32') {
    WRITES.writeFile(join(dir, 'npx.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    WRITES.writeFile(join(dir, 'npx'), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  }
}

for (const launcher of ['managed', 'npx', 'local']) {
  test(`a ${launcher} registration and the approval it hands a person share one set of folders, whatever the client’s environment (3j, 8a)`, async (t) => {
    /*
     * Custom folders, nowhere an environment would derive them from: the installer writes them into the entry, and
     * the client starts the server with an environment whose every suite variable names a decoy. The approval the
     * server hands over must reach the same store, and the change must land in the same configuration.
     */
    const m = await machine({
      relative: {
        configDir: join('custom', 'cfg'),
        stateDir: join('custom', 'st'),
        dataDir: join('custom', 'dt'),
        secretsDir: join('custom', 'sec'),
      },
    });
    if (launcher === 'managed') managedRuntime(m.folders.dataDir);
    const npxDir = join(m.root, 'npx-bin');
    if (launcher === 'npx') {
      fakeNpx(npxDir);
      m.env.PATH = [npxDir, m.nodeBin, strippedPath()].join(process.platform === 'win32' ? ';' : ':');
    }
    const { id, hint } = held(
      m.print(['mcp', 'install', '--client', 'cursor', '--launcher', launcher, '--no-verify', '--json']),
    );
    const install = commandEndingWith(hint, [
      'mcp',
      'install',
      '--client',
      'cursor',
      '--launcher',
      launcher,
      '--no-verify',
      '--approval',
      id,
    ]);
    assert.equal(runNode(argvOf(install).slice(1), m).status, 0);
    const entry = JSON.parse(readFileSync(join(m.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.agentcomms;
    assert.deepEqual(pinsOf(entry.args), Object.fromEntries(FOUR_FOLDERS.map((key) => [key, m.folders[key]])));
    assert.ok(!entry.args.includes(PATH_OPTIONS.downloadsDir), 'downloads are a handoff’s, never a registration’s');
    assert.equal(entry.args.at(-1), 'mcp');
    // A managed entry starts the stable launcher (design 2026-10-16, U6): the program itself on POSIX, so the pins come
    // first; Node's first word on Windows, as a local entry's script is.
    assert.equal(
      entry.args.indexOf(PATH_OPTIONS.configDir),
      launcher === 'npx' ? 2 : launcher === 'managed' && process.platform !== 'win32' ? 0 : 1,
      'the pins come after the launcher, the entry or the package, before `mcp`',
    );
    assert.equal(m.print(['policy', 'confirm']).status, 0);

    // The client: every suite variable a decoy, its own PATH from the entry.
    const client = freshShell(join(m.root, 'client'));
    const serverEnv = { ...client.env, ...entry.env };
    const server = startMcpServer(entry.command, entry.args, { env: serverEnv, cwd: client.cwd });
    t.after(() => server.close());
    const allowed = join(m.root, `allowed-${launcher}`);
    WRITES.mkdir(allowed);
    const asked = await server.call('comms_attach', { rootsAdd: allowed });
    assert.equal(asked.approvalRequired, true, JSON.stringify(asked));
    const approve = commandEndingWith(asked.next, ['approve', asked.approvalId]);
    if (process.platform !== 'win32') {
      // Printed by the server the client started, with the client's environment and the registration's own.
      assertLocated(approve, {
        entry: CORE,
        folders: m.folders,
        tail: ['approve', asked.approvalId],
        printedWith: serverEnv,
      });
    }
    assert.ok(existsSync(join(m.folders.stateDir, 'approvals', `${asked.approvalId}.json`)), 'in the pinned state');

    const person = shellUnder(m.root, 'person');
    if (process.platform === 'win32') {
      inWindowsShells(approve, person, (result, name) => {
        assert.match(`${result.stdout}${result.stderr}`, /needs an interactive terminal/, name);
      });
      assert.ok(
        audit(m.folders.stateDir).some(
          (record) => record.approvalId === asked.approvalId && record.operation === 'change.approve',
        ),
      );
    } else if (NEEDS_TERMINAL.skip === undefined) {
      const approved = posixTerminal(approve, person);
      assert.equal(approved.status, 0, approved.stdout);
      const applied = await server.call('comms_attach', { rootsAdd: allowed, approvalId: asked.approvalId });
      assert.equal(applied.applied, true, JSON.stringify(applied));
      assert.ok(configOf(m).defaults.attachRoots.includes(allowed), 'the server’s change is in the pinned config');
    }
    assertClean(person);
    assertClean(client);
  });
}

test(
  'on Windows a registration made from roaming and local AppData apart keeps both, and the file secrets with them (3j)',
  ON_WINDOWS,
  async (t) => {
    const root = real(await tempDir('agentcomms-real-shell-split-'));
    const appData = join(root, 'Roaming');
    const localAppData = join(root, 'Local');
    const m = await machine({ relative: {}, env: { APPDATA: appData, LOCALAPPDATA: localAppData } });
    const config = join(appData, 'agent-communications');
    const local = join(localAppData, 'agent-communications');
    WRITES.mkdir(config, { recursive: true });
    WRITES.writeFile(join(config, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);
    const folders = {
      configDir: config,
      stateDir: join(local, 'state'),
      dataDir: local,
      secretsDir: join(local, 'secrets'),
    };
    const { id, hint } = held(
      m.print(['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--no-verify', '--json']),
    );
    const install = commandEndingWith(
      hint,
      ['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--no-verify', '--approval', id],
      'win32',
    );
    assert.equal(runNode(argvOf(install, 'win32').slice(1), m).status, 0);
    const entry = JSON.parse(readFileSync(join(m.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.agentcomms;
    assert.deepEqual(pinsOf(entry.args), folders);
    assert.equal(m.print(['policy', 'confirm']).status, 0);

    const client = freshShell(join(m.root, 'client'));
    const server = startMcpServer(entry.command, entry.args, { env: { ...client.env, ...entry.env }, cwd: client.cwd });
    t.after(() => server.close());
    const allowed = join(m.root, 'allowed');
    WRITES.mkdir(allowed);
    const asked = await server.call('comms_attach', { rootsAdd: allowed });
    assert.ok(existsSync(join(folders.stateDir, 'approvals', `${asked.approvalId}.json`)), 'the local state');
    const approve = commandEndingWith(asked.next, ['approve', asked.approvalId], 'win32');
    const approveWords = wordsOf(approve, 'win32');
    if (approveWords !== null) assert.deepEqual(pinsOf(approveWords), folders);
    const person = shellUnder(m.root, 'person');
    inWindowsShells(approve, person, (result, name) => {
      assert.match(`${result.stdout}${result.stderr}`, /needs an interactive terminal/, name);
    });
    assert.ok(audit(folders.stateDir).some((record) => record.approvalId === asked.approvalId));
    assertClean(person);
    assertClean(client);
  },
);

// ── 8a, 8b: another product's command ────────────────────────────────────────────────────────────────────────────

test('core hands over Gmail’s own command from a same-version registration, which runs from a fresh shell; Slack’s, run by npx, is not locatable and has no words to run (8a, 8b)', async () => {
  const m = await machine();
  // Gmail registered as a checkout's built CLI, from before the pins; Slack only through npx.
  WRITES.mkdir(join(m.home, '.cursor'));
  WRITES.writeFile(
    join(m.home, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        gmail: { command: process.execPath, args: [GMAIL, 'mcp'] },
        slack: { command: join(m.root, 'no-npx', 'npx'), args: ['-y', `@agentcomms/slack@${VERSION}`, 'mcp'] },
      },
    }),
  );
  const checks = envelope(m.print(['doctor', '--json'])).data.checks;
  const gmail = checks.find((check) => check.name === 'gmail server');
  const slack = checks.find((check) => check.name === 'slack server');
  const tail = ['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--force'];
  const command = commandEndingWith(gmail.fix, tail);
  if (process.platform !== 'win32')
    assertLocated(command, { entry: GMAIL, folders: m.folders, tail, printedWith: m.env });

  // No executable words for Slack: the product, the release it needs and why — never a bare name or an npx line.
  assert.deepEqual(commandsIn(slack.fix), [], slack.fix);
  assert.match(
    slack.fix,
    new RegExp(`Slack ${VERSION.replaceAll('.', '\\.')} \\(@agentcomms/slack\\) is not locatable here`),
  );
  assert.ok(!slack.fix.includes(process.execPath) && !/agent-slack|npx -y/.test(slack.fix), slack.fix);
  // Only the keychain probe of doctor itself was refused: no connection.
  assert.deepEqual(
    sealAttempts(m.sealLog).filter((attempt) => attempt.what !== 'keychain'),
    [],
  );

  // Gmail's command, pasted: Gmail's own CLI, on the printing process's store.
  const shell = shellUnder(m.root, 'shell');
  const check = (result, name) => {
    assert.equal(result.status, 10, `${name}: ${result.stdout}${result.stderr}`);
    const id = /approval (ap_[0-9A-Z]+)/.exec(`${result.stdout}${result.stderr}`)?.[1];
    assert.ok(id, `${name}: ${result.stdout}${result.stderr}`);
    assert.ok(existsSync(join(m.folders.stateDir, 'approvals', `${id}.json`)), `${name}: the printing store`);
    // Gmail's own rerun, from Gmail's entry, on the same folders.
    const rerun = commandEndingWith(result.stderr, [...tail, '--approval', id]);
    if (process.platform !== 'win32')
      assertLocated(rerun, {
        entry: GMAIL,
        folders: m.folders,
        tail: [...tail, '--approval', id],
        printedWith: shell.env,
      });
  };
  if (process.platform === 'win32') inWindowsShells(command, shell, check);
  else check(posixShell(command, shell), 'sh');
  assertClean(shell);
});
