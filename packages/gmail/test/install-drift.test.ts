import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { run } from '../src/cli/program.ts';
import { VERSION } from '../src/version.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';

/*
 * `agent-gmail mcp install` is the change `comms_server_install` makes (core's `serverInstallChange`), so it is held
 * to the same rule: what the install does is what was planned — whether it registers or only prints, where, what it
 * replaces, and what the server is pinned to — and a machine that moved between the plan and the install is a
 * refusal with nothing written. Core's `install-drift.test.ts` holds the tool to it; this holds the command.
 *
 * The command runs in-process, with an environment whose PATH moves inside the one run: the first time the installer
 * looks for the client is the plan's look, and every later one the install's. The client is a stand-in that records
 * what it was asked; nothing touches a real client, config, keychain or npm.
 */

const NOT_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'the stand-in client is a script, which Windows cannot spawn without a shell' }
    : {};

interface Machine {
  harness: Harness;
  /** On PATH from the start. */
  bin: string;
  /** Not on PATH until a test puts it there. */
  later: string;
  env: NodeJS.ProcessEnv;
}

async function machine(): Promise<Machine> {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const home = tempDir();
  const bin = join(home, 'bin');
  const later = join(home, 'later');
  mkdirSync(bin);
  mkdirSync(later);
  const env: NodeJS.ProcessEnv = {
    ...harness.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: bin,
  };
  return { harness, bin, later, env };
}

/** PATH as `first` the first time anything reads it, and as `then` every time after. Returns how often it was read. */
function racingPath(env: NodeJS.ProcessEnv, first: string, then: string): () => number {
  let reads = 0;
  Object.defineProperty(env, 'PATH', {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return reads === 1 ? first : then;
    },
  });
  return () => reads;
}

/** Our own Gmail entry of this release, pinned to one mailbox, as the npx launcher writes it. */
const PINNED = { command: 'npx', args: ['-y', `@agentcomms/gmail-mcp@${VERSION}`, '--inbox', 'work'] };

/**
 * A stand-in for `codex` that records every call and succeeds. It answers `mcp get` with `entry` for the first
 * `answers` times it is asked, and "No MCP server named …" after that: somebody removed it in between.
 */
function fakeCodex(dir: string, options: { entry?: typeof PINNED; answers?: number } = {}): () => string[] {
  const log = join(dir, 'codex.log');
  const count = join(dir, 'codex.gets');
  const path = join(dir, 'codex');
  writeFileSync(
    path,
    [
      // This node, by path: the client CLI is started with the install's own environment, whose PATH has none.
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const argv = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(log)}, argv.join(" ") + "\\n");`,
      'if (argv[0] === "mcp" && argv[1] === "get") {',
      `  const asked = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0) + 1;`,
      `  fs.writeFileSync(${JSON.stringify(count)}, String(asked));`,
      `  const entry = ${JSON.stringify(options.entry ?? null)};`,
      `  if (!entry || asked > ${options.answers ?? Number.MAX_SAFE_INTEGER}) {`,
      '    process.stderr.write("Error: No MCP server named \'" + argv[2] + "\' found.\\n");',
      '    process.exit(1);',
      '  }',
      '  const transport = { type: "stdio", command: entry.command, args: entry.args, env: null, env_vars: [], cwd: null };',
      '  process.stdout.write(JSON.stringify({ name: argv[2], enabled: true, transport }));',
      '}',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
}

const writesOf = (calls: string[]) => calls.filter((call) => !call.startsWith('mcp get '));

/** The command, in-process, as an agent runs it: no terminal, JSON out. The environment is passed as it is. */
async function command(m: Machine, argv: string[]) {
  let stdout = '';
  const out = new PassThrough();
  const err = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  err.resume();
  const input = new PassThrough();
  input.end();
  const code = await run([...argv, '--json'], {
    core: m.harness.core,
    env: m.env,
    streams: {
      stdout: Object.assign(out, { isTTY: false }),
      stderr: Object.assign(err, { isTTY: false }),
      stdin: Object.assign(input, { isTTY: false }),
    },
  });
  const envelope = JSON.parse(stdout) as {
    ok: boolean;
    error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  };
  return { code, envelope };
}

function assertDrifted(result: Awaited<ReturnType<typeof command>>, what: RegExp) {
  assert.equal(result.code, 78, JSON.stringify(result.envelope));
  assert.equal(result.envelope.error?.code, 'CONFIG');
  assert.match(result.envelope.error?.message ?? '', /changed between being planned and being applied/);
  assert.match(result.envelope.error?.message ?? '', what);
  assert.match(result.envelope.error?.message ?? '', /nothing was written/);
}

test(
  '`agent-gmail mcp install`: a client that appears after a print-only plan is not registered with, unasked',
  NOT_ON_WINDOWS,
  async () => {
    const m = await machine();
    const calls = fakeCodex(m.later);
    const reads = racingPath(m.env, m.bin, [m.later, m.bin].join(delimiter));
    const result = await command(m, [
      'mcp',
      'install',
      '--client',
      'codex',
      '--standalone',
      '--launcher',
      'npx',
      '--no-verify',
    ]);
    assert.ok(reads() >= 2, 'the install looked for the client again');
    assertDrifted(result, /codex was not on PATH when this was planned, and is now/);
    assert.deepEqual(writesOf(calls()), [], 'codex was never asked to add anything');
    assert.deepEqual(await m.harness.core.approvals.list(), [], 'nobody was asked');
  },
);

test(
  '`agent-gmail mcp install --force`: a pinned entry removed after the approval is not replaced by an unpinned one',
  NOT_ON_WINDOWS,
  async () => {
    const m = await machine();
    // Asked once for the approval, once when it is claimed; gone by the third.
    const calls = fakeCodex(m.bin, { entry: PINNED, answers: 2 });
    const argv = ['mcp', 'install', '--client', 'codex', '--standalone', '--launcher', 'npx', '--force', '--no-verify'];

    const asked = await command(m, argv);
    assert.equal(asked.code, 10, JSON.stringify(asked.envelope));
    assert.equal(asked.envelope.error?.code, 'APPROVAL_PENDING');
    assert.match(
      String(asked.envelope.error?.details?.preview),
      /pinned to the mailbox work, replacing its own earlier entry of that name, which served the mailbox work, and keeping --inbox work from it/,
    );
    const approvalId = String(asked.envelope.error?.details?.approvalId);

    assertDrifted(await command(m, [...argv, '--approval', approvalId]), /is not what it was planned to replace/);
    assert.deepEqual(writesOf(calls()), [], 'codex was never asked to remove or add anything');
  },
);
