import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { asV2 } from '../src/approval-stored.ts';
import { ApprovalStore } from '../src/approvals.ts';
import { type GatedChange, gatedChange } from '../src/change-flow.ts';
import { CHANNEL_SERVERS } from '../src/channel-servers.ts';
import type { Streams } from '../src/cli-runtime.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { type CoreMcpOptions, createCoreMcpServer } from '../src/mcp/server.ts';
import { changePolicyChange } from '../src/operations/change-policy.ts';
import { orgAddChange, orgRemoveChange } from '../src/operations/organisations.ts';
import {
  type RegistrationItem,
  type UpdateDeps,
  type UpdateReport,
  type UpdateResult,
  type UpdateStep,
  updateCheck,
  updateCheckFindings,
} from '../src/operations/update.ts';
import { updateAutoChange, updateLaterChange } from '../src/operations/update-settings.ts';
import {
  askUnderClaim,
  checkForUpdates,
  claimUpdateCheck,
  terminalUpdateHooks,
  UPDATE_CHECK_CHILD_COMMAND,
  updateCheckChildEntry,
  updateCheckChildEnvironment,
} from '../src/update-check.ts';
import {
  approvalsOf,
  claimsApproval,
  DOWNLOAD_CLAIM,
  exemptFromUpdateGate,
  SEND_LOOKUP,
  updateGateAtTerminal,
  updateToolGate,
} from '../src/update-gate.ts';
import {
  changeUpdateCheck,
  nextLocalMidnight,
  pendingUpdate,
  readUpdateCheck,
  UPDATE_CHECK_FILE,
  UPDATE_CHECK_LEASE_MS,
  UPDATE_FIRST,
  UPDATE_STARTED_BY_ENV,
  type UpdateCheckRecord,
  updateCheckPath,
  updateVerdict,
} from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { v1SendRecord } from './fixtures/approval-v1-0.13.0.ts';
import { coreInline, locatedCoreLine } from './helpers/handoffs.ts';
import { liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';
import { v2Record } from './helpers/v2-records.ts';

/*
 * The daily update check (design 2026-09-28): once a day the machine asks npm for the latest release, and every
 * server and command stops — "Hang on a minute, there's an update. Let's update first." — until it is updated or put
 * off until midnight.
 *
 * Nothing here reaches npm. The registry is a function a test hands the checker, or a server on the loopback address;
 * every machine's `npm_config_registry` points at a port nobody answers on besides, so an ask that slipped past a
 * stand-in fails at once rather than reaching the real one. The clock is the test's.
 */

const LATEST = '99.0.0';
const OLD = '0.0.1';
const CORE = '@agentcomms/core';
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
/** The core's server, and its command: what a verdict is asked for. */
const SERVER = { channel: 'core', surface: 'server' } as const;
const COMMAND = { channel: 'core', surface: 'command' } as const;
const EMPTY: UpdateCheckRecord = {
  lastChecked: null,
  latest: null,
  behind: null,
  current: null,
  lastError: null,
  snoozedUntil: null,
  checking: null,
};

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  stateDir: string;
}

/** A home of its own with the check **on**: nothing here sets the switch every other harness sets. */
function machine(extra: Record<string, string> = {}): Machine {
  const home = tempDir('comms-update-gate-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    NO_COLOR: '1',
    npm_config_offline: 'true',
    // Nobody answers here: an ask that got past a stand-in fails at once instead of reaching the real registry.
    npm_config_registry: 'http://127.0.0.1:9/',
    ...extra,
  };
  const core = openCore({ env, caller: CORE_CALLER });
  return { home, env, core, stateDir: core.paths.stateDir };
}

/**
 * The file as a check would have left it, asked at `at` — written under the check's own lock, as every writer does. A
 * call starts a check in the background; written around the lock, the seed could land between that check reading the
 * file and writing its claim back, and the claim would put the file back as it was before the seed.
 */
async function seed(m: Machine, record: Partial<UpdateCheckRecord>, at = new Date()): Promise<void> {
  mkdirSync(m.stateDir, { recursive: true });
  await changeUpdateCheck(m.stateDir, () => ({
    record: {
      lastChecked: at.toISOString(),
      latest: null,
      behind: null,
      lastError: null,
      snoozedUntil: null,
      ...record,
    } as UpdateCheckRecord,
  }));
}

/** A registry that answers `latest` for core, counting the asks. */
function registry(latest: string | (() => Promise<string>) = LATEST) {
  const asked: string[] = [];
  const latestVersion = async (name: string) => {
    asked.push(name);
    return typeof latest === 'string' ? latest : latest();
  };
  return { asked, latestVersion };
}

/** The update's other stand-ins: nothing registered, and `global` installed globally. */
function deps(latestVersion: UpdateDeps['latestVersion'], global: Record<string, string> = { [CORE]: OLD }) {
  const installed = { ...global };
  return {
    latestVersion,
    globalPackages: async () => ({ ...installed }),
    installGlobal: async (spec: string) => {
      const at = spec.lastIndexOf('@');
      installed[spec.slice(0, at)] = spec.slice(at + 1);
    },
    installRuntime: async () => undefined,
  } satisfies UpdateDeps;
}

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/** A registry that cannot be reached: what a server is handed when a test is not about the registry. */
const unreachable = async (): Promise<string> => {
  throw new Error('the registry could not be reached (a test that is not about it)');
};

async function connect(m: Machine, options: Partial<CoreMcpOptions> = {}) {
  const { server } = await createCoreMcpServer({
    core: m.core,
    env: m.env,
    keyring: null,
    update: deps(unreachable),
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

const textOf = (result: ToolResult) => result.content?.find((part) => part.type === 'text')?.text ?? '';
const codeOf = (result: ToolResult) =>
  (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
const stopped = (result: ToolResult) => codeOf(result) === 'UPDATE_REQUIRED';

/** Polls until `ready` holds, or fails after `ms`. */
async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ── The reader carries no network code ───────────────────────────────────────────────────────────────────────

test('the reader, the gate and "not now" import nothing that reaches the registry', () => {
  /*
   * WhatsApp imports exactly these, and promises it reaches no network: the modules they reach, followed through
   * every value import, must not include the checker, `npm.ts` or the update — which all ask the registry — nor any
   * network module, nor call `fetch`.
   */
  const seen = new Set<string>();
  const stack = ['update-state.ts', 'update-gate.ts', join('operations', 'update-settings.ts')].map((file) =>
    join(SRC, file),
  );
  const bare = new Set<string>();
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/gm)) {
      if (match[1]) continue; // a type is erased; it reaches nothing at run time
      const specifier = match[2] as string;
      if (specifier.startsWith('.')) stack.push(join(dirname(file), specifier));
      else bare.add(specifier.replace(/^node:/, ''));
    }
    for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      bare.add((match[1] as string).replace(/^node:/, ''));
    }
    assert.doesNotMatch(
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      /\bfetch\s*\(/,
      `${file} calls fetch`,
    );
  }
  const reached = [...seen].map((file) => file.slice(SRC.length).replaceAll('\\', '/'));
  assert.ok(reached.includes('update-state.ts') && reached.includes('change-flow.ts'), 'the graph was read');
  for (const asks of ['npm.ts', 'update-check.ts', 'operations/update.ts']) {
    assert.ok(!reached.includes(asks), `the reader reaches ${asks}, which asks the registry`);
  }
  const network = ['net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'dns/promises', 'undici'];
  assert.deepEqual(
    [...bare].filter((name) => network.includes(name)),
    [],
  );
});

// ── The checker: once a day, for the whole machine ────────────────────────────────────────────────────────────

test('a stale file triggers one check, and never a second in the same day — two at once included', async () => {
  const m = machine();
  const { asked, latestVersion } = registry();
  const start = new Date('2026-09-28T09:00:00.000Z');
  const at = (ms: number) => () => new Date(start.getTime() + ms);
  const check = (ms: number) => checkForUpdates(m.core, m.env, { deps: deps(latestVersion), now: at(ms) });

  // No file at all is as stale as a file can be. Two calls at the same moment: one asks.
  const [first, second] = await Promise.all([check(0), check(0)]);
  assert.deepEqual([first.asked, second.asked].sort(), [false, true]);
  assert.deepEqual(asked, [CORE], 'the registry was asked once, for core alone');
  const record = await readUpdateCheck(m.stateDir);
  assert.equal(record.lastChecked, start.toISOString());
  assert.equal(record.latest, LATEST);
  assert.equal(record.behind, true, 'the global core at 0.0.1 is behind');

  // The rest of the day: nothing.
  for (const ms of [60_000, 12 * 3_600_000, 24 * 3_600_000 - 1]) {
    assert.equal((await check(ms)).asked, false, `asked again ${ms} ms later`);
  }
  assert.equal(asked.length, 1);
  // A day on, once.
  assert.equal((await check(24 * 3_600_000)).asked, true);
  assert.equal((await check(24 * 3_600_000 + 1)).asked, false);
  assert.equal(asked.length, 2);
  // Another process's clock, read a moment before this claim was written, is not a clock gone back.
  assert.equal((await check(24 * 3_600_000 - 5)).asked, false, 'a clock read milliseconds earlier asked again');
  // A clock that did go back — hours — asks: the record is from its future, and cannot be trusted.
  assert.equal((await check(20 * 3_600_000)).asked, true);
  assert.equal(asked.length, 3);
});

test('the claim and the ask are two steps: one claim a day, and the ask handed it records as of the claim', async () => {
  // What lets a command claim the day's check and hand the ask to another process: the claim is taken once, and the
  // ask, given the claim's time, records the day's check and gives the claim up.
  const m = machine();
  const start = new Date('2026-09-28T09:00:00.000Z');
  const at = (ms: number) => () => new Date(start.getTime() + ms);
  const claimedAt = await claimUpdateCheck(m.core, { now: at(0) });
  assert.equal(claimedAt, start.toISOString());
  assert.equal((await readUpdateCheck(m.stateDir)).checking, claimedAt, 'the claim is in the file');
  assert.equal(await claimUpdateCheck(m.core, { now: at(1_000) }), null, 'claimed twice inside the lease');
  const { asked, latestVersion } = registry();
  await askUnderClaim(m.core, m.env, claimedAt as string, { deps: deps(latestVersion), now: at(2_000) });
  assert.deepEqual(asked, [CORE]);
  const record = await readUpdateCheck(m.stateDir);
  assert.deepEqual(
    [record.lastChecked, record.latest, record.behind, record.checking],
    [at(2_000)().toISOString(), LATEST, true, null],
  );
  // The day is used: nothing claims it again.
  assert.equal(await claimUpdateCheck(m.core, { now: at(60_000) }), null);
});

/**
 * A registry on the loopback address that answers `latest` for core after `delayMs`, and counts every request — and
 * every answer, once it is given.
 */
async function loopbackRegistry(latest: string, delayMs: number) {
  const requests: string[] = [];
  const answered: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? '');
    setTimeout(() => {
      answered.push(request.url ?? '');
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ name: CORE, 'dist-tags': { latest }, versions: { [latest]: {} } }));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    answered,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test('two processes that find the file a day old at the same moment ask the registry once between them', async () => {
  const m = machine();
  // Slow enough that both are asking at once unless one of them does not ask at all.
  const served = await loopbackRegistry(LATEST, 1_500);
  const dir = tempDir('comms-update-race-');
  const go = join(dir, 'go');
  const script = join(dir, 'check.ts');
  writeFileSync(
    script,
    [
      `import { writeFileSync, existsSync } from 'node:fs';`,
      `import { openCore } from ${JSON.stringify(pathToFileURL(join(SRC, 'core.ts')).href)};`,
      `import { checkForUpdates } from ${JSON.stringify(pathToFileURL(join(SRC, 'update-check.ts')).href)};`,
      'const env = JSON.parse(process.env.GATE_ENV);',
      'const core = openCore({ env });',
      // Ready, then wait for the word: both start the check within a few milliseconds of each other.
      'writeFileSync(process.env.READY, "");',
      `while (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 5));`,
      'const outcome = await checkForUpdates(core, env, { deps: { globalPackages: async () => ({}) } });',
      'process.stdout.write(JSON.stringify({ asked: outcome.asked }));',
      '',
    ].join('\n'),
  );
  const env = { ...m.env, npm_config_registry: served.url };
  const child = (name: string) => {
    const ready = join(dir, `${name}.ready`);
    const process_ = spawn(process.execPath, [...NODE_FLAGS, script], {
      env: { PATH: process.env.PATH ?? '', GATE_ENV: JSON.stringify(env), READY: ready },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    process_.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    process_.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const done = new Promise<{ asked: boolean }>((resolve, reject) => {
      process_.once('error', reject);
      process_.once('close', (code) =>
        code === 0 ? resolve(JSON.parse(stdout) as { asked: boolean }) : reject(new Error(`exit ${code}: ${stderr}`)),
      );
    });
    return { ready, done };
  };
  try {
    const one = child('one');
    const two = child('two');
    await until(() => existsSync(one.ready) && existsSync(two.ready), 'both processes to start', 60_000);
    writeFileSync(go, '');
    const outcomes = await Promise.all([one.done, two.done]);
    assert.deepEqual(outcomes.map((outcome) => outcome.asked).sort(), [false, true], 'one of them asked');
    assert.deepEqual(served.requests, ['/@agentcomms%2fcore'], 'the registry was asked once');
    assert.equal((await readUpdateCheck(m.stateDir)).latest, LATEST);
  } finally {
    await served.close();
  }
});

test('offline, the check stops nothing: it keeps the last result, says why, and is not tried again that day', async () => {
  const m = machine();
  const offline = registry(async () => {
    throw new Error('http://127.0.0.1:9 could not be reached (ECONNREFUSED)');
  });
  const now = new Date();
  const outcome = await checkForUpdates(m.core, m.env, { deps: deps(offline.latestVersion), now: () => now });
  assert.equal(outcome.asked, true);
  assert.equal(outcome.record.latest, null);
  assert.equal(outcome.record.lastChecked, now.toISOString(), 'the ask counts as the day’s');
  assert.match(String(outcome.record.lastError), /ECONNREFUSED/);
  assert.equal(
    await pendingUpdate({ core: m.core, env: m.env, running: VERSION, ...SERVER }),
    null,
    'nothing is stopped',
  );
  assert.equal((await checkForUpdates(m.core, m.env, { deps: deps(offline.latestVersion) })).asked, false);
  assert.equal(offline.asked.length, 1);

  // A machine that knew of an update before going offline still knows of it: the file keeps its last result.
  const known = machine();
  await seed(known, { latest: LATEST, behind: true }, new Date(Date.now() - 25 * 3_600_000));
  await checkForUpdates(known.core, known.env, { deps: deps(offline.latestVersion) });
  const kept = await readUpdateCheck(known.stateDir);
  assert.equal(kept.latest, LATEST);
  assert.equal(kept.behind, true);
});

test('a hanging registry never delays a tool call: the check runs in the background and the gate reads the file', async () => {
  const m = machine();
  let answer: (version: string) => void = () => undefined;
  const hanging = registry(() => new Promise<string>((resolve) => (answer = resolve)));
  const { call, close } = await connect(m, { update: deps(hanging.latestVersion) });
  try {
    const started = Date.now();
    const first = await call('comms_channels_available');
    assert.ok(Date.now() - started < 2_000, 'the call waited for the registry');
    assert.equal(first.isError, undefined, JSON.stringify(first.structuredContent));
    await until(() => hanging.asked.length === 1, 'the background check to ask');
    // The registry answers; once the file says so, the next call is stopped.
    answer(LATEST);
    await until(async () => (await readUpdateCheck(m.stateDir)).behind === true, 'the check to be recorded');
    const second = await call('comms_channels_available');
    assert.ok(stopped(second), JSON.stringify(second.structuredContent));
    assert.equal(hanging.asked.length, 1, 'one check, whatever the number of calls');
  } finally {
    await close();
  }
});

test('a prerelease named latest never stops anything, in the file or from the registry', async () => {
  const m = machine();
  await seed(m, { latest: '99.0.0-rc.1', behind: true });
  assert.equal(await pendingUpdate({ core: m.core, env: m.env, running: VERSION, ...SERVER }), null);
  const { call, close } = await connect(m);
  try {
    assert.ok(!stopped(await call('comms_channels_available')));
  } finally {
    await close();
  }
  // Asked of the registry: recorded as it said, and not counted.
  const fresh = machine();
  const rc = registry('99.0.0-rc.1');
  const outcome = await checkForUpdates(fresh.core, fresh.env, { deps: deps(rc.latestVersion) });
  assert.equal(outcome.record.latest, '99.0.0-rc.1');
  assert.equal(outcome.record.behind, null);
  assert.equal(await pendingUpdate({ core: fresh.core, env: fresh.env, running: VERSION, ...SERVER }), null);
  // And the release after it is: 99.0.0 is newer than anything this checkout is.
  await seed(fresh, { latest: LATEST, behind: true });
  assert.notEqual(await pendingUpdate({ core: fresh.core, env: fresh.env, running: VERSION, ...SERVER }), null);
});

// ── The server's stop ───────────────────────────────────────────────────────────────────────────────────────────

test('an update that is out stops a tool with the owner’s words, and never the update, the doctor or the paths', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const { latestVersion } = registry();
  const { call, close } = await connect(m, { update: deps(latestVersion) });
  try {
    const result = await call('comms_channels_available');
    assert.equal(result.isError, true);
    assert.ok(textOf(result).startsWith(UPDATE_FIRST), textOf(result));
    assert.ok(textOf(result).startsWith("Hang on a minute, there's an update. Let's update first."));
    assert.match(
      textOf(result),
      new RegExp(`This is the core server, ${VERSION.replaceAll('.', '\\.')}; the latest release is 99\\.0\\.0`),
    );
    assert.match(textOf(result), /comms_update/);
    // Both ways on as this installation's own commands, located, and no npx form beside them.
    assert.ok(textOf(result).includes(coreInline(m.core.paths, ['update'])), textOf(result));
    assert.ok(textOf(result).includes(coreInline(m.core.paths, ['update', '--later'])), textOf(result));
    assert.match(textOf(result), /`later: true`/);
    assert.doesNotMatch(textOf(result), /npx/);
    assert.match(textOf(result), /a plugin's, an extension's — is updated where it was installed/);
    assert.match(textOf(result), /comms_channels_available did not run/);
    // Claude Code and Codex show the model only the structured content: the same words are there.
    const error = (result.structuredContent as { error: { message: string; details: Record<string, unknown> } }).error;
    assert.ok(error.message.startsWith(UPDATE_FIRST));
    assert.equal(error.details.running, VERSION);
    assert.equal(error.details.latest, LATEST);
    assert.equal(error.details.installed, false);

    for (const [name, args] of [
      ['comms_update', { check: true }],
      ['comms_doctor', {}],
      ['comms_paths', {}],
    ] as const) {
      const passed = await call(name, args);
      assert.ok(!stopped(passed), `${name} was stopped`);
      assert.notEqual(passed.isError, true, `${name}: ${JSON.stringify(passed.structuredContent)}`);
    }
  } finally {
    await close();
  }
});

test('a call that claims an approval this machine holds goes ahead; an empty or unknown one, and a new call, are stopped', async () => {
  const m = machine();
  const { call, close } = await connect(m);
  try {
    // Prepared before the check landed.
    const prepared = await call('comms_update', { later: true });
    const approvalId = (prepared.structuredContent as { approvalId: string }).approvalId;
    assert.match(approvalId, /^ap_/);
    assert.equal(await claimsApproval(m.core, approvalId), true);
    // The check lands.
    await seed(m, { latest: LATEST, behind: true });
    const revoke = await call('comms_approval_revoke', { approvalId });
    assert.ok(!stopped(revoke), JSON.stringify(revoke.structuredContent));
    assert.equal(revoke.isError, undefined);
    // The key alone claims nothing. Let past, each of these would run the tool's first call with an update out — and
    // a tightening applies at once: the policy would be `confirm` now, with no approval claimed at all.
    for (const claimed of ['', 'ap_', 'not-an-approval', `ap_${'0'.repeat(26)}`]) {
      assert.equal(await claimsApproval(m.core, claimed), false, JSON.stringify(claimed));
      const result = await call('comms_change_policy', { set: 'confirm', approvalId: claimed });
      assert.ok(stopped(result), `${JSON.stringify(claimed)}: ${JSON.stringify(result.structuredContent)}`);
    }
    assert.equal((await m.core.config.load()).defaults.changePolicy, undefined, 'the policy was changed');
    // Without one: stopped.
    assert.ok(stopped(await call('comms_change_policy', { set: 'confirm' })));
  } finally {
    await close();
  }
});

/** An approval prepared for `change`, as its first call leaves it: pending. */
async function preparedFor<T>(m: Machine, change: GatedChange<T>): Promise<string> {
  const outcome = await gatedChange(m.core, change, { channel: 'core', surface: 'mcp' });
  assert.equal(outcome.status, 'approval-required');
  return (outcome as { prepared: { approvalId: string } }).prepared.approvalId;
}

/**
 * Approvals the store holds that are no longer waiting to be used — revoked, used, expired — and a send's, still
 * waiting: none of them is a claim to a change now. Made through the store's own transitions, before the update is
 * found; "used" snoozes the check on its way, so the caller seeds the file after.
 */
const SEND_OWNER = 'ibx_AAAAAAAAAAAAAAAA';

/** `acme/gmail`, the mailbox the sends and questions here are for, so the store finds their owner as it classifies. */
async function addMailbox(m: Machine): Promise<void> {
  await m.core.config.update((config) => ({
    ...config,
    inboxes: {
      ...config.inboxes,
      'acme/gmail': {
        id: SEND_OWNER,
        provider: 'gmail',
        email: 'jo@acme.test',
        identity: 'oidc',
        client: 'desktop',
        tier: 'send',
        contacts: false,
        grantedScopes: [],
        secretRef: `gmail:refresh:${SEND_OWNER}`,
        internalDomains: ['acme.test'],
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    },
  }));
}

async function spentApprovals(m: Machine): Promise<Record<'revoked' | 'used' | 'expired' | 'a send', string>> {
  const revoked = await preparedFor(m, updateLaterChange(m.core));
  await m.core.approvals.revoke(revoked, 'the person said no', { disposition: 'person' });
  const used = await preparedFor(m, updateLaterChange(m.core));
  const claimed = await gatedChange(m.core, updateLaterChange(m.core), {
    channel: 'core',
    surface: 'mcp',
    approvalId: used,
  });
  assert.equal(claimed.status, 'applied');
  const anHourAgo = new ApprovalStore(m.stateDir, {
    now: () => new Date(Date.now() - 3_600_000),
    loadConfig: () => m.core.config.load(),
  });
  const expired = (
    await anHourAgo.createChange({
      channel: 'core',
      change: { summary: 'An hour ago', target: null, loosened: [], effects: ['did something an hour ago'] },
      policy: 'chat',
    })
  ).approvalId;
  await addMailbox(m);
  const send = (
    await m.core.approvals.create({
      inboxId: SEND_OWNER,
      draftId: 'draft_one',
      draftMessageId: 'revision_one',
      channel: 'gmail',
      sendEpoch: 0,
      contentDigest: 'a'.repeat(64),
      policy: 'chat',
      requiredPolicy: 'chat',
      riskFlags: [],
      expect: { to: ['someone@example.test'], cc: [], bcc: [], subject: 'Hello' },
    })
  ).approvalId;
  const ids = [revoked, used, expired, send];
  const states = await Promise.all(ids.map(async (id) => asV2(await m.core.approvals.get(id))?.state));
  assert.deepEqual(states, ['revoked', 'used', 'expired', 'pending']);
  return { revoked, used, expired, 'a send': send };
}

test("a used, revoked or expired approval claims nothing, nor a send's for a change; one prepared for another change reaches only a refusal", async () => {
  const m = machine();
  const spent = await spentApprovals(m);
  await seed(m, { latest: LATEST, behind: true });
  const { call, close } = await connect(m);
  try {
    // Records stay in the store after they are spent; one of those let any call past the stop for as long as it
    // was kept. And every core tool that takes an approval claims a change, so a send's claims nothing here.
    for (const [label, approvalId] of Object.entries(spent)) {
      const result = await call('comms_change_policy', { set: 'confirm', approvalId });
      assert.ok(stopped(result), `${label}: ${JSON.stringify(result.structuredContent)}`);
    }
    assert.equal((await m.core.config.load()).defaults.changePolicy, undefined, 'the policy was changed');

    // Stopped, an agent can still have "not now" prepared — the update's own tools are never stopped — and hand
    // its id on. It is waiting and a change, so it goes past the stop; but a tightening needs no approval and claims
    // none, and refuses one rather than being applied where the call itself was stopped.
    const later = (await call('comms_update', { later: true })).structuredContent as { approvalId: string };
    const borrowed = await call('comms_change_policy', { set: 'confirm', approvalId: later.approvalId });
    assert.ok(!stopped(borrowed));
    assert.equal(codeOf(borrowed), 'USAGE', JSON.stringify(borrowed.structuredContent));
    assert.match(textOf(borrowed), /needs no approval/);
    assert.equal((await m.core.config.load()).defaults.changePolicy, undefined, 'the tightening was applied');
    assert.equal(
      asV2(await m.core.approvals.get(later.approvalId))?.state,
      'pending',
      'the person can still say not now',
    );

    // Revoking takes either kind: a person's no to a send reaches it past the stop.
    const revoke = await call('comms_approval_revoke', { approvalId: spent['a send'] });
    assert.ok(!stopped(revoke), JSON.stringify(revoke.structuredContent));
    assert.equal(asV2(await m.core.approvals.get(spent['a send']))?.state, 'revoked');
  } finally {
    await close();
  }
});

test("a look-up of a send goes past the stop by the approval it went under, used or not, and only with a send's", async () => {
  const m = machine();
  const spent = await spentApprovals(m);
  const send = spent['a send'];
  // After the update is found, as an agent that was stopped can have "not now" prepared.
  await seed(m, { latest: LATEST, behind: true });
  const later = await preparedFor(m, updateLaterChange(m.core));
  // The store's own path for a send that went: claimed, then completed.
  const { claimToken } = await m.core.approvals.claimForSend(send, {
    inboxId: SEND_OWNER,
    draftMessageId: 'revision_one',
    contentDigest: 'a'.repeat(64),
    expect: { to: ['someone@example.test'], cc: [], bcc: [], subject: 'Hello' },
  });
  await m.core.approvals.complete(send, claimToken, { sentMessageId: 'email_one' });
  assert.equal(asV2(await m.core.approvals.get(send))?.state, 'used');

  assert.equal(await claimsApproval(m.core, send, SEND_LOOKUP), true, 'a used send, looked up');
  assert.equal(await claimsApproval(m.core, send), false, 'a used send, claimed');
  assert.equal(await claimsApproval(m.core, spent.revoked, SEND_LOOKUP), false, "a change's, looked up as a send");
  assert.equal(await claimsApproval(m.core, later, SEND_LOOKUP), false, "a change's, waiting, looked up as a send");
  assert.equal(await claimsApproval(m.core, later), true, 'waiting, and no kind asked for');

  const gate = updateToolGate({
    core: m.core,
    env: m.env,
    server: 'agent-resend',
    channel: 'resend',
    running: VERSION,
    exempt: [],
    approvals: { resend_send_status: SEND_LOOKUP },
  });
  assert.equal(await gate('resend_send_status', { approvalId: send }), null);
  assert.notEqual(await gate('resend_send_status', { approvalId: later }), null);
  assert.notEqual(await gate('resend_send_execute', { approvalId: send }), null, 'a used approval claims nothing');
});

/**
 * A record written where the store keeps it, under its own id, as a person's edit or another release would leave it:
 * the classification is what is tested, not the transitions that would have made it.
 */
function plant(m: Machine, approvalId: string, record: object | string): string {
  const dir = join(m.stateDir, 'approvals');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${approvalId}.json`), typeof record === 'string' ? record : JSON.stringify(record));
  return approvalId;
}
const idOf = (n: number) => `ap_${String(n).padStart(26, '0')}`;

test('what claims an approval is its classification under the lock: pending, or approved and claimable — never a corrupt, an earlier release’s, a revoked-by-reading or an unreadable one', async () => {
  const m = machine();
  const live = liveConfig(m.home, { inboxes: { 'acme/gmail': { id: SEND_OWNER } } });
  const start = Date.now() - 60_000;
  const send = { kind: 'send' as const };
  const pending = plant(m, idOf(1), v2Record({ kind: 'send', state: 'pending', start, approvalId: idOf(1) }));
  const approved = plant(
    m,
    idOf(2),
    v2Record({ kind: 'send', state: 'approved', route: 'confirm', via: 'terminal', start, approvalId: idOf(2) }),
  );
  const legacy = plant(
    m,
    idOf(3),
    v1SendRecord({
      approvalId: idOf(3),
      inboxId: SEND_OWNER,
      draftId: 'r1',
      draftMessageId: 'm1',
      digest: 'b'.repeat(64),
      expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'hi' },
      createdAt: new Date(start).toISOString(),
    }),
  );
  const tampered = { ...v2Record({ kind: 'send', state: 'pending', start, approvalId: idOf(4) }), draftId: 'r-other' };
  const unverifiable = plant(m, idOf(4), tampered);
  const unreadable = plant(m, idOf(5), '{"approvalId": "');
  const verified = plant(m, idOf(6), {
    ...v2Record({ kind: 'send', state: 'pending', start, approvalId: idOf(6) }),
    expiresAt: new Date(start + 5 * 60_000).toISOString(),
  });

  // As the configuration stands: a pending send claims, and so does an approved one it lets be claimed.
  assert.equal(await claimsApproval(m.core, pending, send), true, 'pending');
  assert.equal(await claimsApproval(m.core, approved, send), true, 'approved, claimable');
  for (const [label, id] of Object.entries({ legacy, unverifiable, unreadable, verified })) {
    assert.equal(await claimsApproval(m.core, id, send), false, `${label} claims nothing`);
    assert.equal(await claimsApproval(m.core, id), false, `${label} claims nothing, of any kind`);
  }
  // A look-up reads any record it can read — an earlier release's too — and nothing it cannot.
  assert.equal(await claimsApproval(m.core, legacy, SEND_LOOKUP), true, 'an earlier release’s, looked up');
  for (const id of [unverifiable, unreadable, verified])
    assert.equal(await claimsApproval(m.core, id, SEND_LOOKUP), false);
  // Of another kind: not found, and so nothing.
  assert.equal(await claimsApproval(m.core, pending, { kind: 'change' }), false, 'a send, claimed as a change');

  // Sending turned off, before the change's own revocation reached them: the pending one still goes past the stop —
  // its claim is what revokes it, with POLICY_NEVER — and the approved one, which nothing can claim now, does not.
  live.write({ inboxes: { 'acme/gmail': { id: SEND_OWNER, sendPolicy: 'never' } } });
  assert.equal(await claimsApproval(m.core, pending, send), true, 'pending, under never');
  assert.equal(await claimsApproval(m.core, approved, send), false, 'approved, not claimable under never');

  // Prepared before a never: revoked by reading, whatever the policy is now — and nothing written by the look.
  live.write({ inboxes: { 'acme/gmail': { id: SEND_OWNER } }, sendEpochs: { [SEND_OWNER]: 1 } });
  for (const id of [pending, approved]) {
    assert.equal(await claimsApproval(m.core, id, send), false, 'a stale epoch claims nothing');
    assert.equal(await claimsApproval(m.core, id, SEND_LOOKUP), true, 'and is still there to look up');
  }
  // Its mailbox removed: revoked by reading too.
  live.write({ inboxes: {} });
  assert.equal(await claimsApproval(m.core, pending, send), false, 'an owner removed claims nothing');
  for (const id of [pending, approved]) {
    assert.equal(asV2(await m.core.approvals.get(id))?.state, id === pending ? 'pending' : 'approved', 'not written');
  }
});

test('old-server calls end closed on the digest version: the stop holds an earlier release’s record, and its exception reaches only the version refusal (D1cc-c)', async () => {
  const m = machine();
  liveConfig(m.home, { inboxes: { 'acme/gmail': { id: SEND_OWNER } } });
  const start = Date.now() - 60_000;
  const expect = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'hi' };
  const legacy = plant(
    m,
    idOf(7),
    v1SendRecord({
      approvalId: idOf(7),
      inboxId: SEND_OWNER,
      draftId: 'r1',
      draftMessageId: 'm1',
      digest: 'b'.repeat(64),
      expect,
      createdAt: new Date(start).toISOString(),
    }),
  );
  const current = plant(m, idOf(8), v2Record({ kind: 'send', state: 'pending', start, approvalId: idOf(8) }));
  await seed(m, { latest: LATEST, behind: true });
  const gate = updateToolGate({
    core: m.core,
    env: m.env,
    server: 'agent-gmail',
    channel: 'gmail',
    running: OLD,
    exempt: [],
    approvals: { gmail_draft_send: { kind: 'send' }, gmail_send_status: SEND_LOOKUP },
  });
  // Stopped: an earlier release's pending record claims nothing.
  const stoppedCall = (await gate('gmail_draft_send', { approvalId: legacy })) as { structuredContent?: unknown };
  assert.match(JSON.stringify(stoppedCall?.structuredContent), /UPDATE_REQUIRED/);
  // Its exception: a look-up of it goes ahead — and whatever acts on it next is refused by the version, writing nothing.
  assert.equal(await gate('gmail_send_status', { approvalId: legacy }), null);
  const before = readFileSync(join(m.stateDir, 'approvals', `${legacy}.json`), 'utf8');
  await assert.rejects(
    m.core.approvals.claimForSend(legacy, {
      inboxId: SEND_OWNER,
      draftMessageId: 'm1',
      contentDigest: 'b'.repeat(64),
      expect,
    }),
    (error: unknown) =>
      error instanceof CommsError &&
      error.code === 'APPROVAL_VOID' &&
      /prepared by a different version/.test(error.message) &&
      (error.details?.approval as { legacy?: boolean } | undefined)?.legacy === true,
  );
  assert.equal(readFileSync(join(m.stateDir, 'approvals', `${legacy}.json`), 'utf8'), before, 'nothing written');
  // The pending-or-approved exception: a version-2 record this machine holds goes ahead, to the store's own gate.
  assert.equal(await gate('gmail_draft_send', { approvalId: current }), null);
});

test('a wait goes past the stop as a look-up, for any approval this machine can read — and an id nobody prepared does not (decision 7)', async () => {
  const m = machine();
  const spent = await spentApprovals(m);
  await seed(m, { latest: LATEST, behind: true });
  const { call, close } = await connect(m);
  try {
    // A used change and a waiting send alike: status answers while an update is out.
    for (const approvalId of [spent.used, spent['a send']]) {
      const seen = await call('comms_approval_wait', { approvalId, waitSeconds: 0 });
      assert.ok(!stopped(seen), JSON.stringify(seen.structuredContent));
      assert.notEqual(seen.isError, true, JSON.stringify(seen.structuredContent));
    }
    assert.ok(stopped(await call('comms_approval_wait', { approvalId: `ap_${'7'.repeat(26)}`, waitSeconds: 0 })));
  } finally {
    await close();
  }
  const run = (args: string[]) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  const held = run(['approval', 'wait', spent.used, '--wait-seconds', '0', '--json']);
  assert.equal(held.status, 0, held.stdout + held.stderr);
  const unknown = run(['approval', 'wait', `ap_${'7'.repeat(26)}`, '--wait-seconds', '0', '--json']);
  assert.equal(unknown.status, 11, unknown.stdout + unknown.stderr);
});

test('a download’s answer goes past the stop by its question’s choiceId; the answer alone, or another kind’s id, does not', async () => {
  const m = machine();
  await addMailbox(m);
  const question = await m.core.approvals.createDownload({
    channel: 'core',
    download: {
      summary: 'where to save 1 file from acme/gmail',
      target: { kind: 'inbox', name: 'acme/gmail', id: 'ibx_AAAAAAAAAAAAAAAA' },
      operation: 'attachments.download',
      request: { targets: [{ messageId: 'm1', partId: null, filename: null }], maxFiles: 50 },
      files: ['m1/1'],
      names: ['invoice.pdf'],
      folders: { downloads: join(m.home, 'Downloads'), current: m.home },
    },
    policy: 'chat',
  });
  await seed(m, { latest: LATEST, behind: true });
  const later = await preparedFor(m, updateLaterChange(m.core));

  const gate = updateToolGate({
    core: m.core,
    env: m.env,
    server: 'agent-gmail',
    channel: 'gmail',
    running: VERSION,
    exempt: [],
    approvals: { gmail_attachment_download: DOWNLOAD_CLAIM },
  });
  const tool = 'gmail_attachment_download';
  const answer = { inbox: 'acme/gmail', messageIds: ['m1'], saveTo: 'downloads' };
  assert.equal(await gate(tool, { ...answer, choiceId: question.approvalId }), null, 'the answer was stopped');
  assert.notEqual(await gate(tool, { inbox: 'acme/gmail', messageIds: ['m1'] }), null, 'a new request went through');
  assert.notEqual(await gate(tool, answer), null, 'a bare saveTo went through');
  assert.notEqual(await gate(tool, { ...answer, choiceId: later }), null, "a change's id went through as a question");
  // Carried where the tool does not read it, it claims nothing.
  assert.notEqual(await gate(tool, { ...answer, approvalId: question.approvalId }), null, 'approvalId was read');

  // The command's `--choice`, the same way.
  const command = { opts: () => ({ choice: question.approvalId, to: 'downloads' }) };
  const terminalGate = (approvals: unknown[]) =>
    updateGateAtTerminal({
      core: m.core,
      env: m.env,
      binary: 'agent-gmail',
      channel: 'gmail',
      running: VERSION,
      output: { json: true, color: false },
      streams: { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() },
      approvals,
      approvalClaim: DOWNLOAD_CLAIM,
    });
  assert.equal(await terminalGate(approvalsOf(command)), null);
  await assert.rejects(terminalGate(approvalsOf({ opts: () => ({ to: 'downloads' }) })), /UPDATE_REQUIRED|update/i);
  await assert.rejects(terminalGate([later]), /update/i);

  // Once answered it claims nothing more: a used question is not a way past the stop.
  await m.core.approvals.claimForDownload(question.approvalId, {
    target: { kind: 'inbox', name: 'acme/gmail', id: 'ibx_AAAAAAAAAAAAAAAA' },
    operation: 'attachments.download',
    request: { targets: [{ messageId: 'm1', partId: null, filename: null }], maxFiles: 50 },
    files: ['m1/1'],
    names: ['invoice.pdf'],
  });
  assert.notEqual(await gate(tool, { ...answer, choiceId: question.approvalId }), null, 'a used question went through');
});

// ── "Restart", only where restarting starts the latest ─────────────────────────────────────────────────────────

test('an update installed but not yet loaded says to restart the client, not to update', async () => {
  const m = machine();
  // What the check found: every registration of the core server names 99.0.0.
  await seed(m, { latest: LATEST, behind: false, current: { registered: ['core'], global: [] } });
  const { call, close } = await connect(m);
  try {
    const result = await call('comms_audit_tail');
    assert.ok(stopped(result));
    const text = textOf(result);
    assert.match(
      text,
      /^Hang on a minute, the update is installed, but this server isn't running it yet\. Restart the client first\./,
    );
    assert.match(text, /99\.0\.0 is installed on this machine/);
    assert.doesNotMatch(text, /Let's update first/);
    assert.equal(
      (result.structuredContent as { error: { details: { installed: boolean } } }).error.details.installed,
      true,
    );
  } finally {
    await close();
  }

  // And an update applied here is what makes it so: the old server, registered with Cursor, stops saying "update" at
  // once. A server nothing here registers — Gmail's, started by a plugin — is not made "installed" by it.
  const updated = machine();
  cursorWith(updated, { agentcomms: npxEntry('core', OLD) });
  await seed(updated, { latest: LATEST, behind: true });
  const { latestVersion } = registry();
  const server = await connect(updated, { update: deps(latestVersion) });
  try {
    assert.match(textOf(await server.call('comms_audit_tail')), /Let's update first/);
    const first = (await server.call('comms_update', { noVerify: true })).structuredContent as { approvalId: string };
    const applied = await server.call('comms_update', { noVerify: true, approvalId: first.approvalId });
    assert.equal(applied.isError, undefined, JSON.stringify(applied.structuredContent));
    const record = await readUpdateCheck(updated.stateDir);
    assert.equal(record.behind, false);
    assert.deepEqual(record.current, { registered: ['core'], global: ['core'] });
    assert.match(textOf(await server.call('comms_audit_tail')), /Restart the client first/);
    const gmail = await pendingUpdate({
      core: updated.core,
      env: updated.env,
      running: VERSION,
      channel: 'gmail',
      surface: 'server',
    });
    assert.equal(gmail?.kind, 'update');
  } finally {
    await server.close();
  }
});

/** Cursor's own configuration, in this machine's home, holding `servers`: a client the scan reads. */
function cursorWith(m: Machine, servers: Record<string, { command: string; args: string[] }>): void {
  mkdirSync(join(m.home, '.cursor'), { recursive: true });
  writeFileSync(join(m.home, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

/** An entry the npx launcher writes for `channel` — pinned to `version`, or, as one written by hand, to nothing. */
function npxEntry(channel: 'core' | 'gmail', version: string | null): { command: string; args: string[] } {
  const facts = CHANNEL_SERVERS[channel];
  const spec = version === null ? facts.npxPackage : `${facts.npxPackage}@${version}`;
  return { command: 'npx', args: ['-y', spec, ...(facts.npxArgs ?? [])] };
}

test('"restart" is never said for a server the check did not find registered at the latest release', async () => {
  const verdict = (record: Partial<UpdateCheckRecord>, where: { channel: string; surface: 'server' | 'command' }) =>
    updateVerdict({ ...EMPTY, latest: LATEST, ...record }, VERSION, where)?.kind;
  // Nothing behind, and nothing found at the latest either: "update", not "restart" — machine-wide `behind` says
  // nothing about this server. Nor does a check that could not tell.
  assert.equal(verdict({ behind: false, current: null }, SERVER), 'update');
  assert.equal(verdict({ behind: null, current: null }, SERVER), 'update');
  assert.equal(verdict({ behind: false, current: { registered: [], global: [] } }, SERVER), 'update');
  // Each channel its own, and each surface its own: a server by its registrations, a command by its global package.
  const current = { registered: ['gmail'], global: ['core'] };
  assert.equal(verdict({ current }, { channel: 'gmail', surface: 'server' }), 'restart');
  assert.equal(verdict({ current }, SERVER), 'update');
  assert.equal(verdict({ current }, COMMAND), 'restart');
  assert.equal(verdict({ current }, { channel: 'gmail', surface: 'command' }), 'update');

  // The machine the review found: no registration the scan can see (a plugin's server) and no global package. The
  // check finds nothing behind, and the server still says "update".
  const bare = machine();
  const { latestVersion } = registry();
  await checkForUpdates(bare.core, bare.env, { deps: deps(latestVersion, {}) });
  const found = await readUpdateCheck(bare.stateDir);
  assert.equal(found.behind, false);
  assert.deepEqual(found.current, { registered: [], global: [] });
  const { call, close } = await connect(bare);
  try {
    const text = textOf(await call('comms_audit_tail'));
    assert.ok(text.startsWith(UPDATE_FIRST), text);
    assert.doesNotMatch(text, /Restart the client/);
  } finally {
    await close();
  }

  // A hand-written entry that pins no release, and a Gmail one pinned at the latest beside it: Gmail is not known to
  // be at the latest — restarting may start the unpinned one's npx cache — and the machine is not known either way.
  const unpinned = machine();
  cursorWith(unpinned, { gmail: npxEntry('gmail', null), 'gmail-latest': npxEntry('gmail', LATEST) });
  await checkForUpdates(unpinned.core, unpinned.env, { deps: deps(latestVersion, {}) });
  const record = await readUpdateCheck(unpinned.stateDir);
  assert.equal(record.behind, null);
  assert.deepEqual(record.current, { registered: [], global: [] });
  const gate = updateToolGate({
    core: unpinned.core,
    env: unpinned.env,
    server: 'agent-gmail',
    channel: 'gmail',
    running: VERSION,
    exempt: [],
  });
  const stop = (await gate('gmail_search', {})) as { content: { text: string }[] } | null;
  assert.ok(stop?.content[0]?.text.startsWith(UPDATE_FIRST), JSON.stringify(stop));

  // Pinned at the latest and nothing else: that server, and only that one, is "installed".
  const pinned = machine();
  cursorWith(pinned, { gmail: npxEntry('gmail', LATEST) });
  await checkForUpdates(pinned.core, pinned.env, { deps: deps(latestVersion, {}) });
  assert.deepEqual((await readUpdateCheck(pinned.stateDir)).current, { registered: ['gmail'], global: [] });
});

test('a server a plugin or an extension started is told to update, even where the registrations say restart', async () => {
  /*
   * "Restart" is decided per channel, from its registrations. The Claude Code plugin's Gmail server and the Gemini
   * extension's servers are none of them: each pins its own release, which `comms_update` never moves. Beside a
   * registration of the same channel the update moved, such a server was told to restart every day, and restarting
   * started the release the plugin pins. Its launcher, or its manifest, says so in its environment.
   */
  const m = machine();
  await seed(m, { latest: LATEST, behind: false, current: { registered: ['gmail'], global: ['gmail'] } });
  const verdict = async (surface: 'server' | 'command', startedBy?: string) =>
    (
      await pendingUpdate({
        core: m.core,
        env: startedBy === undefined ? m.env : { ...m.env, [UPDATE_STARTED_BY_ENV]: startedBy },
        running: VERSION,
        channel: 'gmail',
        surface,
      })
    )?.kind;
  assert.equal(await verdict('server'), 'restart', 'a registration of it names the latest');
  assert.equal(await verdict('server', 'claude-code-plugin'), 'update');
  assert.equal(await verdict('server', 'gemini-extension'), 'update');
  assert.equal(await verdict('server', ' '), 'restart', 'an empty marker says nothing');
  // A command is run from where it is installed, which the marker is not about.
  assert.equal(await verdict('command', 'claude-code-plugin'), 'restart');
  // And it is the stop a call meets.
  const gate = updateToolGate({
    core: m.core,
    env: { ...m.env, [UPDATE_STARTED_BY_ENV]: 'claude-code-plugin' },
    server: 'agent-gmail',
    channel: 'gmail',
    running: VERSION,
    exempt: [],
  });
  const stop = (await gate('gmail_search', {})) as { content: { text: string }[] } | null;
  assert.ok(stop?.content[0]?.text.startsWith(UPDATE_FIRST), JSON.stringify(stop));
});

/** One client's registration of `channel`'s server, as a report lists it. */
function registration(channel: string, version: string | null, over: Partial<RegistrationItem> = {}): RegistrationItem {
  return {
    kind: 'registration',
    channel,
    package: `@agentcomms/${channel}`,
    client: 'cursor',
    name: channel,
    scope: 'user',
    path: 'mcp.json',
    launcher: 'npx',
    version,
    latest: LATEST,
    narrowing: [],
    ...over,
  };
}

const globalPackage = (name: string, version: string) =>
  ({ kind: 'global', package: name, version, latest: LATEST }) as const;

function report(over: Partial<UpdateReport> = {}): UpdateReport {
  return { core: VERSION, latest: { [CORE]: LATEST }, behind: [], upToDate: [], unpinned: [], unreadable: [], ...over };
}

test('what a check records: a channel is current only on what the scan saw pinning the latest release', () => {
  const find = (over: Partial<UpdateReport>) => updateCheckFindings(report(over), LATEST);
  assert.deepEqual(
    find({}),
    { behind: false, current: { registered: [], global: [] } },
    'nothing seen, nothing current',
  );
  const atLatest = registration('gmail', LATEST);
  assert.deepEqual(find({ upToDate: [atLatest] }).current.registered, ['gmail']);
  // Another registration of the same channel that pins nothing: not current, and the machine not known.
  const unpinned = find({ upToDate: [atLatest], unpinned: [registration('gmail', null, { name: 'mine' })] });
  assert.deepEqual(unpinned, { behind: null, current: { registered: [], global: [] } });
  // Another channel's pins nothing: Gmail is still current.
  assert.deepEqual(find({ upToDate: [atLatest], unpinned: [registration('slack', null)] }).current.registered, [
    'gmail',
  ]);
  // One behind beside one at the latest: not current.
  const behind = find({ upToDate: [atLatest], behind: [registration('gmail', OLD, { name: 'old' })] });
  assert.deepEqual(behind, { behind: true, current: { registered: [], global: [] } });
  // A client's configuration unread may hold another: nothing is current. The global list unread says nothing of
  // registrations.
  const client = { client: 'gemini', path: 'settings.json', reason: 'it is not JSON, even allowing comments' };
  assert.deepEqual(find({ upToDate: [atLatest], unreadable: [client] }).current.registered, []);
  const npm = { client: 'npm', path: 'the global packages (npm ls --global)', reason: 'npm was not found' };
  assert.deepEqual(find({ upToDate: [atLatest], unreadable: [npm] }), {
    behind: null,
    current: { registered: ['gmail'], global: [] },
  });
  // A command's own package, installed globally at the latest; and only its own: gmail-mcp is not agent-gmail.
  assert.deepEqual(find({ upToDate: [globalPackage(CORE, LATEST)] }).current.global, ['core']);
  assert.deepEqual(find({ behind: [globalPackage(CORE, OLD)] }).current.global, []);
  assert.deepEqual(find({ upToDate: [globalPackage('@agentcomms/gmail-mcp', LATEST)] }).current.global, []);
});

test('what an update records: what it moved counts, and a step that failed, was skipped or left for a person does not', () => {
  const core = registration('core', OLD);
  const before = report({ behind: [core, globalPackage(CORE, OLD)] });
  const registered = (
    outcome: 'registered' | 'failed' | 'skipped',
    verification?: 'passed' | 'failed' | 'skipped',
  ): UpdateStep => ({
    kind: 'registration',
    channel: 'core',
    client: core.client,
    name: core.name,
    scope: 'user',
    path: core.path,
    launcher: 'npx',
    from: OLD,
    to: LATEST,
    narrowing: [],
    outcome,
    ...(verification ? { verification } : {}),
  });
  const installed = (outcome: 'updated' | 'failed'): UpdateStep => ({
    kind: 'global',
    package: CORE,
    from: OLD,
    to: LATEST,
    outcome,
  });
  const result = (steps: UpdateResult['steps'], over: Partial<UpdateResult> = {}): UpdateResult => ({
    status: 'updated',
    latest: { [CORE]: LATEST },
    steps,
    manual: [],
    ok: true,
    next: null,
    ...over,
  });
  assert.deepEqual(
    updateCheckFindings(before, LATEST, result([registered('registered', 'skipped'), installed('updated')])),
    { behind: false, current: { registered: ['core'], global: ['core'] } },
  );
  for (const step of [registered('failed'), registered('skipped'), registered('registered', 'failed')]) {
    assert.deepEqual(
      updateCheckFindings(before, LATEST, result([step, installed('failed')], { status: 'failed', ok: false })),
      { behind: true, current: { registered: [], global: [] } },
      JSON.stringify(step),
    );
  }
  // Every step worked, and a second registration of the core server was left for a person: still behind, and the
  // core server is not current — restarting may start the one left behind.
  const left = registration('core', OLD, { name: 'by-hand', launcher: 'other' });
  const withManual = report({ behind: [core, left, globalPackage(CORE, OLD)] });
  assert.deepEqual(
    updateCheckFindings(
      withManual,
      LATEST,
      result([registered('registered'), installed('updated')], { manual: [left] }),
    ),
    { behind: true, current: { registered: [], global: ['core'] } },
  );
  // Nothing it could do — what is behind is all a person's — is still behind; nothing to do at all is not.
  assert.equal(updateCheckFindings(report(), LATEST, result([], { status: 'manual' })).behind, true);
  assert.equal(updateCheckFindings(report(), LATEST, result([], { status: 'up-to-date' })).behind, false);
});

test('what an update records: an old entry by the same name in another scope is not the one it moved', () => {
  /*
   * Claude Code, with a user-scope `gmail` the update registers again, and a `gmail` one project pins to an old
   * release. The update leaves the project's for a person (it registers at user scope only), and in that project
   * Claude Code starts the project's — so Gmail is not known to run the latest there, and restarting would not help.
   * Twice: a local-scope entry, which Claude Code keeps in the same `~/.claude.json` as the user's, told apart only by
   * its scope; and a project-scope one, in the project's own `.mcp.json`.
   */
  const claudeJson = '~/.claude.json';
  const user = registration('gmail', OLD, { client: 'claude-code', path: claudeJson });
  const moved: UpdateStep = {
    kind: 'registration',
    channel: 'gmail',
    client: 'claude-code',
    name: 'gmail',
    scope: 'user',
    path: claudeJson,
    launcher: 'npx',
    from: OLD,
    to: LATEST,
    narrowing: [],
    outcome: 'registered',
    verification: 'passed',
  };
  for (const [label, left] of [
    [
      'local scope, the same file',
      registration('gmail', OLD, { client: 'claude-code', scope: 'project', path: claudeJson }),
    ],
    [
      'project scope, its own file',
      registration('gmail', OLD, { client: 'claude-code', scope: 'project', path: '/work/app/.mcp.json' }),
    ],
  ] as const) {
    const pinnedOld = { ...left, updatable: false, reason: 'it is registered for one project' };
    const findings = updateCheckFindings(report({ behind: [user, pinnedOld] }), LATEST, {
      status: 'manual',
      latest: { [CORE]: LATEST },
      steps: [moved],
      manual: [pinnedOld],
      ok: true,
      next: null,
    });
    assert.deepEqual(findings, { behind: true, current: { registered: [], global: [] } }, label);
  }
  // Moved on its own, the user's entry does make Gmail current: the key still finds the registration it moved.
  assert.deepEqual(
    updateCheckFindings(report({ behind: [user] }), LATEST, {
      status: 'updated',
      latest: { [CORE]: LATEST },
      steps: [moved],
      manual: [],
      ok: true,
      next: null,
    }).current.registered,
    ['gmail'],
  );
});

// ── Not now ───────────────────────────────────────────────────────────────────────────────────────────────────

test('not now lasts until local midnight, and holds for every server on the machine', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const evening = new Date(2026, 8, 28, 21, 30, 0);
  const midnight = nextLocalMidnight(evening);
  assert.deepEqual(
    [midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), midnight.getHours(), midnight.getMinutes()],
    [2026, 8, 29, 0, 0],
  );
  const change = updateLaterChange(m.core, { now: () => evening });
  const plan = await change.plan(await m.core.config.load());
  assert.equal(plan.summary, `Skip the update to ${LATEST} until tomorrow`);
  assert.match(String(plan.effects?.[0]), /until midnight, local time \(2026-09-29 00:00\)/);
  const result = await change.apply(undefined, plan);
  assert.equal(result.snoozedUntil, midnight.toISOString());

  const at = (when: Date) => pendingUpdate({ core: m.core, env: m.env, running: VERSION, now: () => when, ...SERVER });
  assert.equal(await at(evening), null);
  assert.equal(await at(new Date(midnight.getTime() - 1)), null, 'a millisecond before midnight: still put off');
  assert.notEqual(await at(midnight), null, 'at midnight it asks again');

  // Machine-wide: a second server — another process, another core, the same state directory — reads it too.
  const other = { ...m, core: openCore({ env: m.env, caller: CORE_CALLER }) };
  const gate = updateToolGate({
    core: other.core,
    env: m.env,
    server: 'agent-gmail',
    channel: 'gmail',
    running: VERSION,
    exempt: [],
    now: () => evening,
  });
  assert.equal(await gate('gmail_search', {}), null);
  const later = updateToolGate({
    core: other.core,
    env: m.env,
    server: 'agent-gmail',
    channel: 'gmail',
    running: VERSION,
    exempt: [],
    now: () => midnight,
  });
  assert.notEqual(await later('gmail_search', {}), null);
});

test('not now and turning the check off each need the person’s approval, and cannot be applied without it', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const { call, close } = await connect(m);
  try {
    // Not now: a preview and an id, and nothing written yet.
    const later = (await call('comms_update', { later: true })).structuredContent as Record<string, unknown>;
    assert.equal(later.approvalRequired, true);
    assert.equal(later.summary, `Skip the update to ${LATEST} until tomorrow`);
    assert.match(String(later.preview), /puts off the update to 99\.0\.0 until midnight/);
    assert.equal((await readUpdateCheck(m.stateDir)).snoozedUntil, null);
    // An id it did not prepare is refused, and nothing is written.
    const forged = await call('comms_update', { later: true, approvalId: `ap_${'0'.repeat(26)}` });
    assert.equal(forged.isError, true);
    assert.equal((await readUpdateCheck(m.stateDir)).snoozedUntil, null);
    assert.ok(stopped(await call('comms_channels_available')), 'still stopped');
    // With its own id, after the person's yes: put off.
    const applied = (await call('comms_update', { later: true, approvalId: later.approvalId })).structuredContent as {
      applied: boolean;
      result: { snoozedUntil: string };
    };
    assert.equal(applied.applied, true);
    assert.equal(applied.result.snoozedUntil, nextLocalMidnight(new Date()).toISOString());
    assert.ok(!stopped(await call('comms_channels_available')), 'carries on until midnight');

    // Off: a loosening, prepared, and applied only with its id.
    const off = (await call('comms_update', { auto: 'off' })).structuredContent as Record<string, unknown>;
    assert.equal(off.approvalRequired, true);
    assert.match(String(off.preview), /daily update check: on → off/);
    assert.equal((await m.core.config.load()).defaults.updateCheck, undefined);
    const turned = (await call('comms_update', { auto: 'off', approvalId: off.approvalId })).structuredContent as {
      result: { updateCheck: string; changed: boolean };
    };
    assert.deepEqual(turned.result, { updateCheck: 'off', changed: true });
    assert.equal((await m.core.config.load()).defaults.updateCheck, 'off');
    // On: tightening, applied at once.
    const on = (await call('comms_update', { auto: 'on' })).structuredContent as Record<string, unknown>;
    assert.equal(on.applied, true);
    assert.equal((await m.core.config.load()).defaults.updateCheck, 'on');

    // One at a time.
    const both = await call('comms_update', { later: true, auto: 'off' });
    assert.equal(codeOf(both), 'USAGE');
  } finally {
    await close();
  }
  // The store itself refuses turning it off without the person's consent, whoever asks.
  await assert.rejects(
    m.core.config.update((config) => ({ ...config, defaults: { ...config.defaults, updateCheck: 'off' } })),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );
  // And without an approval the change flow applies neither: both need one.
  const fresh = machine();
  await seed(fresh, { latest: LATEST, behind: true });
  // Its home is the test's own: turning the check off looks for the background update job there (design 2026-10-16 U4).
  const changes: GatedChange<unknown>[] = [
    updateLaterChange(fresh.core),
    updateAutoChange(fresh.core, 'off', { env: fresh.env }),
  ];
  for (const change of changes) {
    const request = await change.plan(await fresh.core.config.load());
    const outcome = await gatedChange(fresh.core, change, { channel: 'core', surface: 'mcp' });
    assert.equal(outcome.status, 'approval-required', request.summary);
  }
});

test('the command: --later and --auto off wait for an approval; --auto on applies at once', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const run = (args: string[]) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], {
      encoding: 'utf8',
      env: { ...m.env, CLAUDECODE: '1' },
    });
  const later = run(['update', '--later', '--json']);
  assert.equal(later.status, 10, later.stdout + later.stderr);
  const pending = JSON.parse(later.stdout) as { error: { code: string; hint: string; details: { preview: string } } };
  assert.equal(pending.error.code, 'APPROVAL_PENDING');
  assert.match(pending.error.details.preview, /puts off the update to 99\.0\.0/);
  locatedCoreLine(pending.error.hint, [
    'update',
    '--later',
    '--approval',
    String(pending.error.hint.match(/ap_\w+/)?.[0]),
  ]);
  const off = run(['update', '--auto', 'off', '--json']);
  assert.equal(off.status, 10, off.stdout + off.stderr);
  const on = run(['update', '--auto', 'on', '--json']);
  assert.equal(on.status, 0, on.stdout + on.stderr);
  const bad = run(['update', '--auto', 'maybe', '--json']);
  assert.equal(bad.status, 64);
  const mixed = run(['update', '--later', '--check', '--json']);
  assert.equal(mixed.status, 64);
});

// ── Switched off ──────────────────────────────────────────────────────────────────────────────────────────────

test('CI, AGENT_COMMS_UPDATE_CHECK=off and the machine’s own setting each skip everything: no check, no stop', async () => {
  for (const [label, extra, setting] of [
    ['CI', { CI: 'true' }, undefined],
    ['the switch', { AGENT_COMMS_UPDATE_CHECK: 'off' }, undefined],
    ['the setting', {}, 'off'],
  ] as const) {
    const m = machine(extra);
    if (setting) {
      writeFileSync(
        join(m.env.AGENT_COMMS_CONFIG_DIR as string, 'config.json'),
        JSON.stringify({ version: 2, secrets: { store: 'file' }, defaults: { updateCheck: setting } }),
      );
    }
    const stale = new Date(Date.now() - 3 * 24 * 3_600_000);
    await seed(m, { latest: LATEST, behind: true }, stale);
    const { asked, latestVersion } = registry();
    const outcome = await checkForUpdates(m.core, m.env, { deps: deps(latestVersion) });
    assert.equal(outcome.asked, false, label);
    assert.deepEqual(asked, [], `${label}: the registry was asked`);
    assert.equal(await pendingUpdate({ core: m.core, env: m.env, running: VERSION, ...SERVER }), null, label);
    const { call, close } = await connect(m, { update: deps(latestVersion) });
    try {
      assert.ok(!stopped(await call('comms_channels_available')), label);
    } finally {
      await close();
    }
    const cli = spawnSync(process.execPath, [...NODE_FLAGS, CLI, 'channels', '--json'], {
      encoding: 'utf8',
      env: m.env,
    });
    assert.equal(cli.status, 0, `${label}: ${cli.stdout}${cli.stderr}`);
    assert.equal((await readUpdateCheck(m.stateDir)).lastChecked, stale.toISOString(), `${label}: file rewritten`);
  }
  // `CI=false` and `CI=0` are not CI.
  const notCi = machine({ CI: 'false' });
  await seed(notCi, { latest: LATEST, behind: true });
  assert.notEqual(await pendingUpdate({ core: notCi.core, env: notCi.env, running: VERSION, ...SERVER }), null);
});

// ── The terminal ──────────────────────────────────────────────────────────────────────────────────────────────

test('which commands are never stopped: update, doctor, paths, approve, approvals, help, and the server itself', () => {
  for (const path of [
    ['update'],
    ['doctor'],
    ['paths'],
    ['approve', 'ap_x'],
    ['approvals', 'list'],
    ['help'],
    ['mcp'],
    [],
  ]) {
    assert.equal(exemptFromUpdateGate(path), true, path.join(' '));
  }
  for (const path of [
    ['channels'],
    ['policy'],
    ['mcp', 'install'],
    ['mcp', 'prune'],
    ['audit', 'tail'],
    ['search'],
    // A channel's command that writes to this machine: Slack's `files download`, Gmail's `attachments download`.
    ['files', 'download'],
    ['attachments', 'download'],
  ]) {
    assert.equal(exemptFromUpdateGate(path), false, path.join(' '));
  }
  assert.equal(exemptFromUpdateGate(['status'], ['status']), true, 'a channel adds its own doctor');
});

test('the approvals a command claims: --approval, --mcp-approval, --choice, and an argument named approvalId', () => {
  // As Commander hands a `preAction` hook the command: its options, and its arguments as read.
  const command = {
    opts: () => ({
      approval: 'ap_one',
      mcpApproval: 'ap_two',
      choice: 'ap_four',
      to: 'current',
      account: 'acme/resend',
    }),
    registeredArguments: [{ name: () => 'inbox' }, { name: () => 'approvalId' }],
    processedArgs: ['work', 'ap_three'],
  };
  // `--choice` is a download's question; `--to`, the answer beside it, is not an approval and is not read.
  assert.deepEqual(approvalsOf(command), ['ap_one', 'ap_two', 'ap_four', 'ap_three']);
  assert.deepEqual(approvalsOf({ opts: () => ({}) }), [undefined, undefined, undefined]);
});

/** A terminal a person answers: each prompt on stderr gets the next answer, and every answer is used. */
function terminal(answers: string[]) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  const queue = [...answers];
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
    if (/\? $|: $/.test(String(chunk)) && queue.length > 0) {
      const answer = queue.shift() as string;
      setImmediate(() => stdin.write(`${answer}\n`));
    }
  });
  return {
    streams: { stdin, stdout, stderr } as unknown as Streams,
    out: () => out,
    err: () => err,
    left: () => queue.length,
  };
}

async function gateAt(
  m: Machine,
  answers: string[],
  extra: Partial<Parameters<typeof updateGateAtTerminal>[0]> = {},
  update: UpdateDeps = deps(registry().latestVersion),
) {
  const tty = terminal(answers);
  const output = extra.output ?? { json: false, color: false };
  const outcome = await updateGateAtTerminal({
    core: m.core,
    env: m.env,
    binary: 'agentcomms',
    channel: 'core',
    running: VERSION,
    output,
    streams: tty.streams,
    ...terminalUpdateHooks(m.core, m.env, { channel: 'core', output, streams: tty.streams, deps: update }),
    ...extra,
  }).then(
    (value) => ({ value, error: null as CommsError | null }),
    (error: CommsError) => ({ value: null, error }),
  );
  return { ...outcome, tty };
}

test('at a terminal: "Update now, later today, or cancel?" — and each answer does what it says', async () => {
  // Cancel: nothing runs, nothing changes.
  const cancelled = machine();
  await seed(cancelled, { latest: LATEST, behind: true });
  const cancel = await gateAt(cancelled, ['cancel']);
  assert.match(
    cancel.tty.err(),
    new RegExp(
      `^${LATEST.replaceAll('.', '\\.')} is out \\(you have ${VERSION.replaceAll('.', '\\.')}\\)\\. Update now, later today, or cancel\\? `,
    ),
  );
  assert.equal(cancel.error?.code, 'USAGE');
  assert.match(String(cancel.error?.message), /cancelled: the command did not run/);
  assert.equal((await readUpdateCheck(cancelled.stateDir)).snoozedUntil, null);

  // Later: put off until midnight — the answer is the approval — and the command runs.
  const put = machine();
  await seed(put, { latest: LATEST, behind: true });
  const later = await gateAt(put, ['later']);
  assert.equal(later.error, null, String(later.error));
  assert.equal(later.value, null, 'the command runs');
  assert.equal(later.tty.left(), 0);
  assert.doesNotMatch(later.tty.err(), /Type yes/, 'nothing more was asked under chat');
  assert.equal((await readUpdateCheck(put.stateDir)).snoozedUntil, nextLocalMidnight(new Date()).toISOString());

  // Now: the update, with its own preview and yes, then "run your command again" — and the command does not run.
  const now = machine();
  await seed(now, { latest: LATEST, behind: true });
  const update = await gateAt(now, ['now', 'yes']);
  assert.equal(update.error, null, String(update.error));
  assert.equal(update.value, 0);
  assert.match(update.tty.out(), /CHANGE PREVIEW/);
  assert.match(update.tty.out(), /updates the global @agentcomms\/core from 0\.0\.1 to 99\.0\.0/);
  assert.match(update.tty.out(), /Updated\. Run your command again\.\n$/);
  assert.equal((await readUpdateCheck(now.stateDir)).behind, false, 'recorded as updated');
  assert.equal((await pendingUpdate({ core: now.core, env: now.env, running: VERSION, ...COMMAND }))?.kind, 'restart');

  // Without a network-capable update (WhatsApp): it says what to run, and ends.
  const reader = machine();
  await seed(reader, { latest: LATEST, behind: true });
  const handoff = await gateAt(reader, ['now'], { check: undefined, update: undefined, binary: 'agent-whatsapp' });
  assert.equal(handoff.value, 11);
  assert.ok(handoff.tty.out().includes(`Run ${coreInline(reader.core.paths, ['update'])}`), handoff.tty.out());
});

test('with nobody to ask, the command does not run and ends with UPDATE_REQUIRED, exit 11, naming both commands', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: { ...m.env, ...extra } });
  const json = run(['channels', '--json']);
  assert.equal(json.status, 11, json.stdout + json.stderr);
  const error = (JSON.parse(json.stdout) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, 'UPDATE_REQUIRED');
  assert.ok(error.message.startsWith(UPDATE_FIRST));
  // This installation's own update and "not now", located.
  locatedCoreLine(error.message, ['update']);
  locatedCoreLine(error.message, ['update', '--later']);
  const plain = run(['audit', 'tail']);
  assert.equal(plain.status, 11);
  locatedCoreLine(plain.stderr, ['update', '--later']);
  assert.equal(plain.stdout, '', 'the command printed nothing');
  // The exempt ones run.
  for (const args of [['paths', '--json'], ['approvals', 'list', '--json'], ['--version']]) {
    const passed = run(args);
    assert.equal(passed.status, 0, `${args.join(' ')}: ${passed.stdout}${passed.stderr}`);
  }
  // Put off, it runs.
  writeFileSync(
    updateCheckPath(m.stateDir),
    JSON.stringify({
      ...JSON.parse(readFileSync(updateCheckPath(m.stateDir), 'utf8')),
      snoozedUntil: nextLocalMidnight(new Date()).toISOString(),
    }),
  );
  assert.equal(run(['channels', '--json']).status, 0);
});

test('at a terminal the check waits about three seconds at most, then the command goes on without it', async () => {
  const m = machine();
  const started = Date.now();
  // A check that never ends, and hears nothing: nothing but the gate's own wait can end the wait. (A second limit
  // here, so that a gate that waits for ever fails this test rather than hanging it.)
  const gate = updateGateAtTerminal({
    core: m.core,
    env: m.env,
    binary: 'agentcomms',
    channel: 'core',
    running: VERSION,
    output: { json: true, color: false },
    streams: terminal([]).streams,
    check: () => new Promise<void>(() => undefined),
    waitMs: 200,
  });
  let limit: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    gate,
    new Promise<'waited on'>((resolve) => {
      limit = setTimeout(() => resolve('waited on'), 10_000);
    }),
  ]);
  clearTimeout(limit);
  assert.equal(outcome, null, 'nothing known, nothing stopped — and the command went on');
  assert.ok(Date.now() - started < 5_000, `waited ${Date.now() - started} ms`);
  // The real wait is about three seconds.
  const { TERMINAL_CHECK_WAIT_MS } = await import('../src/update-gate.ts');
  assert.equal(TERMINAL_CHECK_WAIT_MS, 3_000);
  assert.equal(existsSync(join(m.stateDir, UPDATE_CHECK_FILE)), false, 'a check that gave up wrote nothing here');
});

test('a registry slower than the terminal waits is still heard from: the check finishes beside the command', async () => {
  const m = machine();
  const served = await loopbackRegistry(LATEST, 1_500);
  const env = { ...m.env, npm_config_registry: served.url };
  try {
    const started = Date.now();
    const output = { json: true, color: false };
    const streams = terminal([]).streams;
    const outcome = await updateGateAtTerminal({
      core: m.core,
      env,
      binary: 'agentcomms',
      channel: 'core',
      running: VERSION,
      output,
      streams,
      ...terminalUpdateHooks(m.core, env, {
        channel: 'core',
        output,
        streams,
        deps: { globalPackages: async () => ({}) },
      }),
      waitMs: 200,
    });
    assert.equal(outcome, null, 'the command goes on');
    assert.ok(Date.now() - started < 1_400, `the command waited ${Date.now() - started} ms for the registry`);
    // The ask was not cut off at the wait: its answer lands, and the day's check is a real one.
    await until(async () => (await readUpdateCheck(m.stateDir)).latest === LATEST, 'the answer to be recorded', 15_000);
    const record = await readUpdateCheck(m.stateDir);
    assert.equal(record.lastError, null);
    assert.equal(record.checking, null, 'the claim was given up');
    assert.deepEqual(served.requests, ['/@agentcomms%2fcore']);
  } finally {
    await served.close();
  }
});

/** The core's command, run as a person's shell runs it: done when its output closes, not when the gate is. */
function command(env: Record<string, string>, args: string[]) {
  const started = Date.now();
  const child = spawn(process.execPath, [...NODE_FLAGS, CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise<{ code: number | null; ms: number; output: string }>((resolve, reject) => {
    child.once('error', reject);
    // 'close', not 'exit': the output is closed only when nothing holds it — a `$(…)` or a pipe waits for exactly this.
    child.once('close', (code) => resolve({ code, ms: Date.now() - started, output: stdout + stderr }));
  });
}

test("the day's first command ends when its own work does: a detached child finishes the ask, and asks once", async () => {
  /*
   * #48: the command waited about three seconds and ran, and the check went on in the same process — the registry's
   * ten seconds, then `npm ls` — so its output stayed open for as long, and anything reading it waited too. The
   * command takes the day's claim and hands the ask to a child of its own that holds none of its output.
   */
  const m = machine();
  const served = await loopbackRegistry(LATEST, 8_000);
  // Globally installed here: nothing, so `npm ls -g` answers at once — and reads no real global folder.
  const env = { ...m.env, npm_config_registry: served.url, npm_config_prefix: tempDir('comms-update-prefix-') };
  try {
    const first = await command(env, ['channels', '--json']);
    assert.equal(first.code, 0, first.output);
    // About three and a half seconds here: the gate's wait, and the command. Held to the registry's clock rather than
    // to a number of seconds, so a slow machine cannot fail it — the registry answers eight seconds after it is asked,
    // and a command whose output something else held open closes only after that.
    assert.deepEqual(
      served.answered,
      [],
      `the command's output closed after ${first.ms} ms, once the registry answered`,
    );
    // Inside the claim's lease, the next command asks nothing and hands nothing on: the child is asking.
    const second = await command(env, ['channels', '--json']);
    assert.equal(second.code, 0, second.output);
    await until(() => served.requests.length > 0, 'the child to ask the registry', 15_000);
    await until(
      async () => {
        const record = await readUpdateCheck(m.stateDir);
        return record.latest === LATEST && record.checking === null;
      },
      'the child to record what the registry said, and give up the claim',
      30_000,
    );
    assert.deepEqual(served.requests, ['/@agentcomms%2fcore'], 'the registry was asked once');
    assert.equal((await readUpdateCheck(m.stateDir)).lastError, null);
    // What the child found stops the next command, as a check in the command's own process would have.
    const third = await command(env, ['channels', '--json']);
    assert.equal(third.code, 11, third.output);
    assert.deepEqual(served.requests, ['/@agentcomms%2fcore'], 'the day was asked about again');
  } finally {
    await served.close();
  }
});

test('a child that cannot be started loses nothing: the command asks in its own process, as it did', async () => {
  const served = await loopbackRegistry(LATEST, 0);
  try {
    const notAllowed = join(tempDir('comms-update-nochild-'), 'node');
    writeFileSync(notAllowed, '', { mode: 0o644 });
    const entries: [string, { command: string; args: string[] } | null][] = [
      ['no entry to start', null],
      ['a program that is not there', { command: join(tempDir('comms-update-nochild-'), 'node'), args: [] }],
    ];
    // Windows has no execute bit to refuse.
    if (process.platform !== 'win32') entries.push(['a program not allowed to run', { command: notAllowed, args: [] }]);
    for (const [label, childEntry] of entries) {
      const m = machine();
      const env = { ...m.env, npm_config_registry: served.url, npm_config_prefix: tempDir('comms-update-prefix-') };
      const asked = served.requests.length;
      const output = { json: true, color: false };
      const streams = terminal([]).streams;
      const outcome = await updateGateAtTerminal({
        core: m.core,
        env,
        binary: 'agentcomms',
        channel: 'core',
        running: VERSION,
        output,
        streams,
        ...terminalUpdateHooks(m.core, env, { channel: 'core', output, streams, childEntry }),
        // Long enough that only the ask's own end ends the wait: asked in this process, it has, by the time this does.
        waitMs: 30_000,
      }).catch((error: unknown) => error);
      // Asked here, and at once: the answer stops this very command, as a fast answer always did.
      assert.equal((outcome as CommsError | null)?.code, 'UPDATE_REQUIRED', `${label}: ${String(outcome)}`);
      const record = await readUpdateCheck(m.stateDir);
      assert.deepEqual([record.latest, record.checking], [LATEST, null], label);
      assert.equal(served.requests.length, asked + 1, `${label}: asked ${served.requests.length - asked} times`);
    }
  } finally {
    await served.close();
  }
});

test('agentcomms finishes the update check a command handed on: under its claim, never stopped, and not in help', async () => {
  const m = machine();
  // A day old with an update known, so every other command would ask first and be stopped.
  await seed(m, { latest: LATEST, behind: true }, new Date(Date.now() - 25 * 3_600_000));
  const claimedAt = await claimUpdateCheck(m.core);
  assert.ok(claimedAt !== null);
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: { ...m.env, ...extra } });
  const child = run([UPDATE_CHECK_CHILD_COMMAND, claimedAt, '--json']);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  // Nobody answers on the registry here: the ask is the day's, with why, and the claim is given up.
  const record = await readUpdateCheck(m.stateDir);
  assert.deepEqual([record.lastChecked, record.checking, record.latest], [claimedAt, null, LATEST]);
  assert.match(String(record.lastError), /could not be reached/);
  // A claim the file does not hold is another process's, or none: nothing is asked under it.
  const served = await loopbackRegistry(LATEST, 0);
  try {
    const stale = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      const env = { ...m.env, npm_config_registry: served.url, npm_config_prefix: tempDir('comms-update-prefix-') };
      const process_ = spawn(process.execPath, [...NODE_FLAGS, CLI, UPDATE_CHECK_CHILD_COMMAND, claimedAt], { env });
      let output = '';
      process_.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      process_.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      process_.once('error', reject);
      process_.once('close', (status) => resolve({ status, output }));
    });
    assert.equal(stale.status, 0, stale.output);
    assert.deepEqual(served.requests, [], 'asked under a claim the file no longer holds');
  } finally {
    await served.close();
  }
  assert.deepEqual(await readUpdateCheck(m.stateDir), record);
  assert.equal(run([UPDATE_CHECK_CHILD_COMMAND, '--json']).status, 64, 'no claim, no ask');
  assert.doesNotMatch(run(['--help']).stdout, new RegExp(UPDATE_CHECK_CHILD_COMMAND));
});

test("a debugger given through NODE_OPTIONS stays with the command: the child's environment keeps every other option", () => {
  const env = {
    PATH: '/x',
    NODE_OPTIONS: '--inspect-brk=0 --max-old-space-size=512 --inspect-port 9230 --enable-source-maps',
  };
  const child = updateCheckChildEnvironment(env);
  assert.equal(child.NODE_OPTIONS, '--max-old-space-size=512 --enable-source-maps');
  assert.equal(child.PATH, '/x');
  assert.equal(env.NODE_OPTIONS.startsWith('--inspect-brk'), true, "the command's own environment is not changed");
  assert.equal('NODE_OPTIONS' in updateCheckChildEnvironment({ NODE_OPTIONS: '--inspect' }), false);
  assert.equal('NODE_OPTIONS' in updateCheckChildEnvironment({ PATH: '/x' }), false);
});

test('NODE_OPTIONS is read as Node reads it: a quoted word stays whole, and on Windows the name is the same in any case', () => {
  const quoted = '--require "/srv/with --inspect hook.js"   --inspect-brk  --title="a \\"quoted\\" name"';
  assert.equal(
    updateCheckChildEnvironment({ NODE_OPTIONS: quoted }, 'linux').NODE_OPTIONS,
    '--require "/srv/with --inspect hook.js" --title="a \\"quoted\\" name"',
  );
  const windows = updateCheckChildEnvironment(
    { Path: 'C:\\x', node_options: '--inspect-brk --max-old-space-size=64' },
    'win32',
  );
  assert.equal(windows.NODE_OPTIONS, '--max-old-space-size=64');
  assert.equal('node_options' in windows, false, 'no second name for the same variable');
  // Elsewhere the name has one case, and another is another variable.
  const linux = updateCheckChildEnvironment({ node_options: '--inspect-brk' }, 'linux');
  assert.equal(linux.node_options, '--inspect-brk');
});

test('every spelling of a debugger flag is taken out, and only a space separates the words of NODE_OPTIONS', () => {
  const flags = [
    '--inspect_brk=0',
    '--inspect-brk-node',
    '--inspect_brk_node=9229',
    '--debug_port',
    '9230',
    '--no-warnings',
  ];
  assert.deepEqual(
    updateCheckChildEntry(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), flags)?.args.slice(0, -1),
    ['--no-warnings'],
  );
  assert.equal(
    updateCheckChildEnvironment({ NODE_OPTIONS: '--inspect_brk=0 --inspect-brk-node --no-warnings' }, 'linux')
      .NODE_OPTIONS,
    '--no-warnings',
  );
  // A tab or a new line is part of a word to Node, so a word holding one is kept whole, as written.
  const tabbed = '--title=a\tb --require=x\ny --inspect';
  assert.equal(
    updateCheckChildEnvironment({ NODE_OPTIONS: tabbed }, 'linux').NODE_OPTIONS,
    '--title=a\tb --require=x\ny',
  );
  // A word may even begin with one: to Node `\t--inspect` is not the debugger's flag, so it stays as written.
  assert.equal(
    updateCheckChildEnvironment({ NODE_OPTIONS: '--a \t--inspect' }, 'linux').NODE_OPTIONS,
    '--a \t--inspect',
  );
});

test("the child is this CLI again: the running script when it is a CLI's entry, links followed, and nothing else", () => {
  const root = tempDir('comms-update-entry-');
  const entry = join(root, 'dist', 'cli.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '');
  const real = realpathSync.native(entry);
  const flags = ['--experimental-strip-types'];
  assert.deepEqual(updateCheckChildEntry(entry, flags), { command: process.execPath, args: [...flags, real] });
  // A debugger's flags stay with the command: a child started with `--inspect-brk` would wait for a debugger nobody
  // attaches until its claim ran out, and one with `--inspect` would fight the command for its port.
  const debugging = [
    '--inspect-brk',
    '--experimental-strip-types',
    '--inspect=9229',
    '--inspect-port',
    '9230',
    '--debug',
  ];
  assert.deepEqual(updateCheckChildEntry(entry, debugging), {
    command: process.execPath,
    args: ['--experimental-strip-types', real],
  });
  // npm's `agentcomms` on PATH is a link to the entry. (Windows starts it through a `.cmd` shim instead, which has
  // already run Node on the `.mjs`: the script is the entry itself.)
  if (process.platform !== 'win32') {
    const link = join(root, 'bin', 'agentcomms');
    mkdirSync(dirname(link));
    symlinkSync(entry, link);
    assert.deepEqual(updateCheckChildEntry(link, []), { command: process.execPath, args: [real] });
  }
  // A CLI's `run()` called from a test runner, a script that is not there, or none: the check is asked in-process.
  assert.equal(updateCheckChildEntry(fileURLToPath(import.meta.url), []), null);
  assert.equal(updateCheckChildEntry(join(root, 'dist', 'missing', 'cli.mjs'), []), null);
  assert.equal(updateCheckChildEntry(undefined, []), null);
});

test('an ask that never finished does not use up the day: its claim runs out and the next process asks', async () => {
  const m = machine();
  const start = new Date('2026-09-28T09:00:00.000Z');
  const at = (ms: number) => () => new Date(start.getTime() + ms);
  // The first process claims the check and is gone before the registry answers — interrupted, or closed by its client.
  const gone = registry(() => new Promise<string>(() => undefined));
  void checkForUpdates(m.core, m.env, { deps: deps(gone.latestVersion), now: at(0) });
  await until(() => gone.asked.length === 1, 'the first process to ask');
  const claimed = await readUpdateCheck(m.stateDir);
  assert.equal(claimed.checking, start.toISOString());
  assert.equal(claimed.lastChecked, null, 'the day was used up before the ask was over');
  // While the claim holds, nobody else asks.
  const next = registry();
  assert.equal(
    (await checkForUpdates(m.core, m.env, { deps: deps(next.latestVersion), now: at(60_000) })).asked,
    false,
  );
  assert.deepEqual(next.asked, []);
  // Once it has run out, the next process does, and the day's check is its.
  const after = await checkForUpdates(m.core, m.env, {
    deps: deps(next.latestVersion),
    now: at(UPDATE_CHECK_LEASE_MS),
  });
  assert.equal(after.asked, true);
  assert.equal(after.record.latest, LATEST);
  assert.equal(after.record.lastChecked, at(UPDATE_CHECK_LEASE_MS)().toISOString());
  assert.equal(after.record.checking, null);
});

test('a check that lands after a newer finding was written drops its own: its claim was given up', async () => {
  /*
   * A background check reads the machine, and before it writes what it read a person's check — or an update — writes
   * what it found. The background check's finding is older, and written over the newer one it would put back the
   * machine as it was before: "update" where "restart" is right. Twice: once through the check's finding, and once
   * through the error it records when the registry failed it.
   */
  const m = machine();
  let release: (packages: Record<string, string>) => void = () => undefined;
  let reading = false;
  const background = checkForUpdates(m.core, m.env, {
    deps: {
      ...deps(registry().latestVersion),
      // What the machine was when the background check read it: the global core behind.
      globalPackages: () => {
        reading = true;
        return new Promise((resolve) => (release = resolve));
      },
    },
  });
  await until(() => reading, 'the background check to read the machine');
  assert.notEqual((await readUpdateCheck(m.stateDir)).checking, null, 'the background check holds its claim');
  // Meanwhile a person asks, after the update: the global core is at the latest.
  await updateCheck(m.core, m.env, deps(registry().latestVersion, { [CORE]: LATEST }));
  const newer = await readUpdateCheck(m.stateDir);
  assert.deepEqual([newer.behind, newer.current?.global, newer.checking], [false, ['core'], null]);
  release({ [CORE]: OLD });
  await background;
  assert.deepEqual(await readUpdateCheck(m.stateDir), newer, 'the older finding was written over the newer one');

  // The registry failing it, after the same newer finding: its error is not written over what was found either.
  const failing = machine();
  let fail: (error: Error) => void = () => undefined;
  const asked = checkForUpdates(failing.core, failing.env, {
    deps: deps(() => new Promise<string>((_, reject) => (fail = reject))),
  });
  await until(async () => (await readUpdateCheck(failing.stateDir)).checking !== null, 'the claim');
  await updateCheck(failing.core, failing.env, deps(registry().latestVersion, { [CORE]: LATEST }));
  const found = await readUpdateCheck(failing.stateDir);
  fail(new Error('the registry could not be reached (ECONNRESET)'));
  await asked;
  assert.deepEqual(await readUpdateCheck(failing.stateDir), found);
});

test('at a terminal, an agent or --json is never asked, even with a terminal on both ends', async () => {
  for (const [label, env, output] of [
    ['an agent (CLAUDECODE)', { CLAUDECODE: '1' }, { json: false, color: false }],
    ['--json', {}, { json: true, color: false }],
  ] as const) {
    const m = machine(env);
    await seed(m, { latest: LATEST, behind: true });
    const asked = await gateAt(m, ['later'], { output });
    assert.equal(asked.error?.code, 'UPDATE_REQUIRED', `${label}: ${String(asked.error)}`);
    assert.equal(asked.tty.err(), '', `${label}: it was asked`);
    assert.equal(asked.tty.left(), 1, `${label}: an answer was taken`);
    assert.equal((await readUpdateCheck(m.stateDir)).snoozedUntil, null, `${label}: put off with nobody asked`);
  }
});

test('at a terminal, an update installed and an older copy running stops as the servers do, and says to run the installed one', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: false, current: { registered: [], global: ['core'] } });
  // Nobody to ask: stopped, and told so — not a note beside a command that runs.
  const script = await gateAt(m, [], { output: { json: true, color: false } });
  assert.equal(script.error?.code, 'UPDATE_REQUIRED');
  assert.match(
    String(script.error?.message),
    /^Hang on a minute, the update is installed, but this command isn't running it yet\./,
  );
  assert.match(String(script.error?.message), /99\.0\.0 is installed globally, and this core CLI is /);
  assert.ok(String(script.error?.message).includes(coreInline(m.core.paths, ['update', '--later'])));
  // A person: now says to run it again from the installed one, ends 11, and runs nothing and updates nothing.
  let updated = false;
  const person = await gateAt(m, ['now'], {
    update: async () => {
      updated = true;
      return 'updated';
    },
  });
  assert.match(person.tty.err(), /^99\.0\.0 is installed \(this is [^)]+\)\. Switch now, later today, or cancel\? /);
  assert.equal(person.value, 11);
  assert.match(person.tty.out(), /Run your command again from the installed one\. The command did not run\./);
  assert.equal(updated, false, 'there was nothing to update');
  // Later: put off, and the command runs.
  const later = await gateAt(m, ['later']);
  assert.equal(later.value, null);
  assert.notEqual((await readUpdateCheck(m.stateDir)).snoozedUntil, null);
});

test('now, at a terminal: "Updated" only when this command is at the latest release after it; the command never runs', async () => {
  // The update has nothing to do — this copy is not what it updates (npx's cache, say): not "Updated", and exit 11.
  const short = machine();
  await seed(short, { latest: LATEST, behind: null });
  const nothing = await gateAt(short, ['now', 'yes'], {}, deps(registry().latestVersion, {}));
  assert.equal(nothing.error, null, String(nothing.error));
  assert.equal(nothing.value, 11);
  assert.doesNotMatch(nothing.tty.out(), /Updated\./);
  assert.match(nothing.tty.out(), /The command did not run: the update did not bring it to 99\.0\.0/);

  // The check could not tell (npm ls unreadable, say), and the global package was at the latest all along: the update
  // changes nothing, and says so — not "Updated" — and the command still did not run.
  const already = machine();
  await seed(already, { latest: LATEST, behind: null });
  const installed = await gateAt(already, ['now', 'yes'], {}, deps(registry().latestVersion, { [CORE]: LATEST }));
  assert.equal(installed.value, 11, installed.tty.out());
  assert.match(installed.tty.out(), /Nothing was changed\./);
  assert.doesNotMatch(installed.tty.out(), /Updated\./);
  assert.match(installed.tty.out(), /99\.0\.0 is installed here: run your command again from it\. It did not run\./);

  // A step fails: said, not "Updated", exit 69 — and the file keeps saying "update", not "restart".
  const failing = machine();
  await seed(failing, { latest: LATEST, behind: true });
  const broken = {
    ...deps(registry().latestVersion),
    installGlobal: async () => {
      throw new Error('npm could not write to the global directory (EACCES)');
    },
  };
  const failed = await gateAt(failing, ['now', 'yes'], {}, broken);
  assert.equal(failed.value, 69, failed.tty.out());
  assert.doesNotMatch(failed.tty.out(), /Updated\./);
  assert.match(failed.tty.out(), /The command did not run: the update did not finish/);
  const record = await readUpdateCheck(failing.stateDir);
  assert.equal(record.behind, true, 'a failed update was recorded as done');
  assert.deepEqual(record.current, { registered: [], global: [] });
  assert.equal(
    (await pendingUpdate({ core: failing.core, env: failing.env, running: VERSION, ...COMMAND }))?.kind,
    'update',
  );
  assert.equal(
    (await pendingUpdate({ core: failing.core, env: failing.env, running: VERSION, ...SERVER }))?.kind,
    'update',
  );
});

test('at a terminal, a command claiming an approval this machine holds runs, as the same call over MCP does', async () => {
  const m = machine();
  const approvalId = await preparedFor(m, updateLaterChange(m.core));
  assert.match(approvalId, /^ap_/);
  await seed(m, { latest: LATEST, behind: true });
  const claimed = await gateAt(m, [], { output: { json: true, color: false }, approvals: [undefined, approvalId] });
  assert.equal(claimed.error, null, String(claimed.error));
  assert.equal(claimed.value, null, 'the command runs');
  for (const approvals of [[''], ['ap_'], [`ap_${'0'.repeat(26)}`], [undefined, undefined]]) {
    const refused = await gateAt(m, [], { output: { json: true, color: false }, approvals });
    assert.equal(refused.error?.code, 'UPDATE_REQUIRED', JSON.stringify(approvals));
  }
  // Held to the kind the command claims, where it says: a change's is no send.
  const kind = await gateAt(m, [], {
    output: { json: true, color: false },
    approvals: [approvalId],
    approvalClaim: { kind: 'send' },
  });
  assert.equal(kind.error?.code, 'UPDATE_REQUIRED');
});

test("at a terminal, a command claiming an approval still starts the day's check", async () => {
  // Over MCP the server starts the check before it looks at a call; a command that goes ahead on an approval is
  // still the day's first command, and starts it too.
  const m = machine();
  const approvalId = await preparedFor(m, updateLaterChange(m.core));
  const { asked, latestVersion } = registry();
  const claimed = await gateAt(
    m,
    [],
    { output: { json: true, color: false }, approvals: [approvalId] },
    deps(latestVersion),
  );
  assert.equal(claimed.error, null, String(claimed.error));
  assert.equal(claimed.value, null, 'the command runs');
  assert.deepEqual(asked, [CORE], "the day's check was not started");
  assert.equal((await readUpdateCheck(m.stateDir)).latest, LATEST);
});

test('agentcomms: an approval a command claims is one still waiting, prepared as a change, and only a command that takes one carries it', async () => {
  const m = machine();
  const spent = await spentApprovals(m);
  // `confirm`, so that `policy chat` is a loosening, and its approval waits for a person at a terminal.
  const tightened = await gatedChange(m.core, changePolicyChange(m.core, {}, 'confirm'), {
    channel: 'core',
    surface: 'cli',
  });
  assert.equal(tightened.status, 'applied');
  const forThis = await preparedFor(m, changePolicyChange(m.core, {}, 'chat'));
  await seed(m, { latest: LATEST, behind: true });
  const run = (args: string[]) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  const errorOf = (result: ReturnType<typeof run>) =>
    (JSON.parse(result.stdout) as { error: { code: string; message: string } }).error;

  // Prepared for this very change: past the stop, to the command's own answer — the person has not typed the code.
  const held = run(['policy', 'chat', '--approval', forThis, '--json']);
  assert.equal(errorOf(held).code, 'APPROVAL_PENDING', held.stdout + held.stderr);
  // Spent, or a send's: stopped, like the command without it.
  for (const [label, approvalId] of Object.entries(spent)) {
    const stoppedHere = run(['policy', 'chat', '--approval', approvalId, '--json']);
    assert.equal(stoppedHere.status, 11, `${label}: ${stoppedHere.stdout}${stoppedHere.stderr}`);
  }

  // A command that takes no approval is refused one as usage, before anything runs — the stop included — as every
  // channel's command is refused an option it does not take, and a tool an argument it does not declare. It used to
  // be handed to the stop, and a held id walked `channels` and `audit tail` straight past it.
  for (const args of [
    ['channels'],
    ['audit', 'tail'],
    ['paths'],
    ['doctor'],
    ['approvals', 'list'],
    ['approve', forThis],
    ['policy'],
    ['mcp'],
    ['org', 'list'],
    ['org', 'show', 'acme'],
  ]) {
    const refused = run([...args, '--json', '--approval', forThis]);
    assert.equal(refused.status, 64, `${args.join(' ')}: ${refused.stdout}${refused.stderr}`);
    assert.equal(errorOf(refused).code, 'USAGE', args.join(' '));
    assert.match(errorOf(refused).message, /takes no --approval|an approval goes with a policy to set/);
  }
  assert.equal(run(['channels', '--json']).status, 11, 'without it, the command is stopped as before');
  assert.equal(asV2(await m.core.approvals.get(forThis))?.state, 'pending', 'nothing claimed or approved it');
});

test('an organisation profile change carries its approval past the stop, from the command and from the tool', async () => {
  /*
   * `org add`, `org update` and `org remove` claim a change with their approval, as every core change does: the CLI's
   * routing (`takesApproval`) and the server's (`approvals`) both have to know them, or a person's yes given moments
   * before the check landed would be stopped — and `org list` and `org show`, which read, would carry an id past it.
   */
  const m = machine();
  const file = join(m.home, 'acme.agentcomms.json');
  writeFileSync(
    file,
    JSON.stringify({
      agentcomms: 'organisation-profile',
      version: 1,
      organisation: 'acme',
      label: 'Acme',
      slack: {
        workspace: 'TACME0001',
        workspaceName: 'Acme',
        redirectPort: 51234,
        apps: { read: { clientId: '1.2' } },
      },
    }),
  );
  const orgOptions = { env: m.env, platform: 'darwin' as const, surface: 'mcp' as const, keyring: null };
  const { 'a send': send } = await spentApprovals(m);
  const adding = await preparedFor(m, orgAddChange(m.core, { file }, orgOptions));
  await seed(m, { latest: LATEST, behind: true });
  const run = (args: string[]) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  assert.equal(run(['org', 'add', file, '--json']).status, 11, 'without the approval: stopped');
  const added = run(['org', 'add', file, '--approval', adding, '--json']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.equal(run(['org', 'list', '--json']).status, 11, 'a read is stopped like any new request');

  const { call, close } = await connect(m);
  try {
    assert.ok(stopped(await call('comms_org_remove', { organisation: 'acme' })), 'a new change is stopped');
    // A send's approval, still waiting, is no claim to a change: the tool says which kind it takes.
    assert.ok(stopped(await call('comms_org_remove', { organisation: 'acme', approvalId: send })), 'a send’s id');
    const removing = await preparedFor(m, orgRemoveChange(m.core, { organisation: 'acme' }, orgOptions));
    const removed = await call('comms_org_remove', { organisation: 'acme', approvalId: removing });
    assert.ok(!stopped(removed), JSON.stringify(removed.structuredContent));
    assert.equal(removed.isError, undefined, JSON.stringify(removed.structuredContent));
  } finally {
    await close();
  }
});

test('a dry run, or a migration with nothing to rename, takes no approval: the id is refused as usage, and nothing is shown or claimed', async () => {
  // The daily check off: the refusal is the path's own, whatever the stop would have done.
  const m = machine({ AGENT_COMMS_UPDATE_CHECK: 'off' });
  const later = await preparedFor(m, updateLaterChange(m.core));
  const configFile = join(m.core.paths.configDir, 'config.json');
  const before = readFileSync(configFile, 'utf8');
  const { call, close } = await connect(m);
  try {
    const dry = await call('comms_names_migrate', { dryRun: true, approvalId: later });
    assert.equal(codeOf(dry), 'USAGE', JSON.stringify(dry.structuredContent));
    assert.match(textOf(dry), /`dryRun` only shows the mapping, so it takes no approvalId/);
    assert.equal((dry.structuredContent as { status?: string }).status, undefined, 'the mapping was shown');
    // Without the id it is the dry run it always was.
    const plain = await call('comms_names_migrate', { dryRun: true });
    assert.equal((plain.structuredContent as { status?: string }).status, 'already-migrated');
    // With nothing to rename, the migration itself refuses one: it needs no approval (`gatedChange`).
    const nothing = await call('comms_names_migrate', { approvalId: later });
    assert.equal(codeOf(nothing), 'USAGE', JSON.stringify(nothing.structuredContent));
    assert.match(textOf(nothing), /needs no approval, so it takes none/);
  } finally {
    await close();
  }

  const run = (args: string[]) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  const errorOf = (result: ReturnType<typeof run>) =>
    (JSON.parse(result.stdout) as { error: { code: string; message: string } }).error;
  const dry = run(['names', 'migrate', '--dry-run', '--approval', later, '--json']);
  assert.equal(dry.status, 64, dry.stdout + dry.stderr);
  assert.equal(errorOf(dry).code, 'USAGE');
  assert.match(errorOf(dry).message, /--dry-run only shows the mapping, so it takes no --approval/);
  // Nothing to rename was reported whatever came with it, dropping the approval: now it is refused in the tool's words.
  const nothing = run(['names', 'migrate', '--approval', later, '--json']);
  assert.equal(nothing.status, 64, nothing.stdout + nothing.stderr);
  assert.match(errorOf(nothing).message, /needs no approval, so it takes none/);
  const reported = run(['names', 'migrate', '--json']);
  assert.equal(reported.status, 0, reported.stdout + reported.stderr);
  assert.equal((JSON.parse(reported.stdout) as { data: { status: string } }).data.status, 'already-migrated');

  assert.equal(readFileSync(configFile, 'utf8'), before, 'the configuration was changed');
  assert.equal(asV2(await m.core.approvals.get(later))?.state, 'pending', 'the approval was claimed');
});

test('stopped, an agent that has "not now" prepared and hands its id to a dry run is refused, and the stop stands', async () => {
  /*
   * The way past the stop, end to end. `comms_update` is never stopped, so an agent that was can have "not now"
   * prepared without the person: a change approval, waiting, which the stop lets a call through on. Handed to a path
   * that took an approval id and claimed none — a report, a dry run, a sign-in's finish — the call went past the stop
   * and ran, and "not now" was the agent's decision after all. Each such path refuses the id now.
   */
  const m = machine();
  // A mailbox by its old name, so the dry run has a mapping to show: what the call would have answered.
  const configFile = join(m.core.paths.configDir, 'config.json');
  writeFileSync(
    configFile,
    `${JSON.stringify({
      version: 1,
      secrets: { store: 'file' },
      inboxes: {
        work: {
          id: 'ibx_AAAAAAAAAAAAAAAA',
          provider: 'gmail',
          email: 'jo@example.com',
          identity: 'oidc',
          sub: 'sub-one',
          client: 'desktop',
          tier: 'read',
          contacts: false,
          grantedScopes: [],
          secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
          internalDomains: ['example.com'],
          createdAt: '2026-09-22T00:00:00.000Z',
        },
      },
    })}\n`,
  );
  const before = readFileSync(configFile, 'utf8');
  await seed(m, { latest: LATEST, behind: true });
  const { call, close } = await connect(m);
  let later = '';
  try {
    assert.ok(stopped(await call('comms_names_migrate', { dryRun: true })), 'the dry run is stopped on its own');
    const prepared = (await call('comms_update', { later: true })).structuredContent as {
      approvalRequired?: boolean;
      approvalId: string;
    };
    assert.equal(prepared.approvalRequired, true, JSON.stringify(prepared));
    later = prepared.approvalId;
    for (const [tool, args] of [
      ['comms_names_migrate', { dryRun: true }],
      ['comms_change_policy', {}],
    ] as const) {
      const result = await call(tool, { ...args, approvalId: later });
      // The stop lets it through — the approval is waiting, and a change — and the tool refuses what it would drop.
      assert.ok(!stopped(result), `${tool} was stopped`);
      assert.equal(codeOf(result), 'USAGE', `${tool}: ${JSON.stringify(result.structuredContent)}`);
    }
  } finally {
    await close();
  }

  // At a terminal: `update --later` hands an agent the id (exit 10), and the dry run it is carried to refuses it.
  const run = (args: string[]) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  const asked = run(['update', '--later', '--json']);
  assert.equal(asked.status, 10, asked.stdout + asked.stderr);
  const id = (JSON.parse(asked.stdout) as { error: { details: { approvalId: string } } }).error.details.approvalId;
  const dry = run(['names', 'migrate', '--dry-run', '--approval', id, '--json']);
  assert.equal(dry.status, 64, dry.stdout + dry.stderr);
  assert.equal((JSON.parse(dry.stdout) as { error: { code: string } }).error.code, 'USAGE');

  // Nothing was renamed or put off: both still wait for the person, and every other call is stopped as before.
  assert.equal(readFileSync(configFile, 'utf8'), before, 'the configuration was changed');
  for (const each of [later, id]) assert.equal(asV2(await m.core.approvals.get(each))?.state, 'pending', each);
  assert.equal((await readUpdateCheck(m.stateDir)).snoozedUntil, null);
  assert.equal(run(['channels', '--json']).status, 11, 'the stop stands');
});

// ── The doctor ────────────────────────────────────────────────────────────────────────────────────────────────

test('the doctor gives the check one line: on or off, when last checked, the latest, and what is running', async () => {
  const m = machine();
  const checked = new Date('2026-09-28T09:00:00.000Z');
  await seed(m, { latest: LATEST, behind: true }, checked);
  const { call, close } = await connect(m);
  try {
    const report = (await call('comms_doctor')).structuredContent as {
      ok: boolean;
      checks: { name: string; detail: string; warn?: boolean; fix?: string }[];
    };
    const line = report.checks.filter((check) => check.name === 'update check');
    assert.equal(line.length, 1);
    assert.equal(line[0]?.detail, `on · last checked ${checked.toISOString()} · latest ${LATEST} · running ${VERSION}`);
    assert.equal(line[0]?.warn, true);
    assert.ok(String(line[0]?.fix).includes(coreInline(m.core.paths, ['update', '--later'])), String(line[0]?.fix));
    // "Installed: restart" only when both the core's server and its command would start the latest: the doctor
    // speaks for both.
    const fixFor = async (current: UpdateCheckRecord['current']) => {
      await seed(m, { latest: LATEST, behind: false, current }, checked);
      const again = (await call('comms_doctor')).structuredContent as { checks: { name: string; fix?: string }[] };
      return String(again.checks.find((check) => check.name === 'update check')?.fix);
    };
    const runUpdate = `Run ${coreInline(m.core.paths, ['update'])}`;
    assert.ok((await fixFor({ registered: ['core'], global: [] })).startsWith(runUpdate));
    assert.ok((await fixFor({ registered: [], global: ['core'] })).startsWith(runUpdate));
    assert.match(await fixFor({ registered: ['core'], global: ['core'] }), /is installed on this machine: restart/);
  } finally {
    await close();
  }
  const off = machine({ AGENT_COMMS_UPDATE_CHECK: 'off' });
  const { call: offCall, close: offClose } = await connect(off);
  try {
    const report = (await offCall('comms_doctor')).structuredContent as { checks: { name: string; detail: string }[] };
    assert.equal(
      report.checks.find((check) => check.name === 'update check')?.detail,
      `off (AGENT_COMMS_UPDATE_CHECK is set) · last checked never · latest unknown · running ${VERSION}`,
    );
  } finally {
    await offClose();
  }
});
