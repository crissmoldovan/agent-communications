import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin, openCore, TEST_PROFILE_MARKER } from '@agentcomms/core';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { localSetupEndpoint } from '../src/domain/judge-setup.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

/*
 * `judge setup`, `provider key set` and `provider key remove` (owner decision 2026-10-26): the person sets up and turns
 * on Jev or a local model server from the desktop app, which runs these with the key on stdin. They refuse an agent's
 * shell and the event service's MCP server; the key comes from stdin, never argv, and appears in no output or audit.
 */

const APPROVAL_EXIT = new CommsError('APPROVAL_REQUIRED', 'x').exitCode;
const USAGE_EXIT = new CommsError('USAGE', 'x').exitCode;
const CONFIG_EXIT = new CommsError('CONFIG', 'x').exitCode;

// Synthetic provider keys: never a real one.
const OPENROUTER_KEY = 'fake-or';
const OPENROUTER_KEY_2 = 'fake-or2';
const TYPESAFE_KEY = 'fake-ts';
const ANTHROPIC_KEY = 'fake-an';

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The release app, attested as the process that started the CLI (core's `desktopAppOrigin`, injected here). */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

/**
 * Runs the CLI as the app does: stdin a pipe holding `stdin`, never a TTY, started by the attested app — or, with `tty`,
 * as a person at an interactive terminal, whose hidden input is `readSecret`.
 */
async function cli(
  args: readonly string[],
  options: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly stateDir?: string;
    readonly desktopOrigin?: () => Promise<DesktopOrigin>;
    readonly tty?: boolean;
    readonly readSecret?: (prompt: string) => Promise<string>;
  } = {},
): Promise<Ran> {
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (options.tty === true) {
    Object.assign(stdin, { isTTY: true });
    Object.assign(stdout, { isTTY: true });
  }
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const streams: EventsCliStreams = { stdin, stdout, stderr };
  const code = await run([...(options.stateDir === undefined ? [] : ['--state-dir', options.stateDir]), ...args], {
    streams,
    env: options.env ?? {},
    desktopOrigin: options.desktopOrigin ?? ATTESTED,
    ...(options.readSecret === undefined ? {} : { readSecret: options.readSecret }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { code, stdout: out, stderr: err };
}

const PERSON_COMMANDS: readonly (readonly string[])[] = [
  ['judge', 'setup', 'typesafe'],
  ['judge', 'setup', 'typesafe', '--provider', 'openrouter'],
  ['judge', 'setup', 'local-endpoint', '--url', 'http://127.0.0.1:11434'],
  ['provider', 'key', 'set', 'openrouter'],
  ['provider', 'key', 'remove', 'openrouter'],
  // The Linear key a Linear target uses (0.33.0 design §3.4) is the person's in the same way.
  ['provider', 'key', 'set', 'linear'],
  ['provider', 'key', 'remove', 'linear'],
];

test('judge setup and provider keys refuse every agent marker and the MCP server, before reading a key or calling the owner', async () => {
  const stateDir = await shortTempDir('aev-setup-refuse-');
  try {
    for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT']) {
      for (const args of PERSON_COMMANDS) {
        const ran = await cli(args, { stdin: `${OPENROUTER_KEY}\n`, env: { [marker]: '1' }, stateDir });
        assert.equal(ran.code, APPROVAL_EXIT, `${args.join(' ')} under ${marker}`);
        assert.match(ran.stderr, /only a person can .*not an agent/u, `${args.join(' ')} under ${marker}`);
        assert.equal(ran.stdout, '', 'nothing reached the owner');
        assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, new RegExp(OPENROUTER_KEY, 'u'));
      }
    }
    for (const args of PERSON_COMMANDS) {
      const ran = await cli(args, { stdin: `${OPENROUTER_KEY}\n`, env: { AGENTCOMMS_MCP_SERVER: 'events' }, stateDir });
      assert.equal(ran.code, APPROVAL_EXIT, `${args.join(' ')} inside the MCP server`);
      assert.match(ran.stderr, /MCP server cannot do it/u);
      assert.equal(ran.stdout, '');
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('from a pipe, the person’s setup is refused unless Agent Comms started it: a key is read from the app or a terminal only', async () => {
  for (const reason of [
    'not-agent-comms',
    'not-a-test-profile',
    'test-app-with-real-profile',
    'test-profile-unknown',
  ]) {
    for (const args of PERSON_COMMANDS) {
      const ran = await cli(args, { stdin: `${OPENROUTER_KEY}\n`, desktopOrigin: async () => ({ ok: false, reason }) });
      assert.equal(ran.code, APPROVAL_EXIT, `${args.join(' ')} ${reason}: ${ran.stderr}`);
      assert.match(ran.stderr, /in the Agent Comms app, or at an interactive terminal/u);
      assert.ok(!ran.stdout.includes(OPENROUTER_KEY) && !ran.stderr.includes(OPENROUTER_KEY));
    }
  }
  // At an interactive terminal the app is never asked about: the person is there.
  const never = async (): Promise<DesktopOrigin> => {
    throw new Error('a terminal asks no attestation');
  };
  const atTerminal = await cli(['judge', 'setup', 'local-endpoint', '--url', 'http://192.0.2.1:11434'], {
    tty: true,
    desktopOrigin: never,
  });
  assert.equal(atTerminal.code, USAGE_EXIT, atTerminal.stderr);
});

test('judge setup carries where the person was: a terminal approves its enablements at the terminal, and every result says who', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-origin-');
  const configDir = await emptyConfigDir(stateDir);
  const opened = await openEventDatabase({ stateDir });
  await selectEventSecretStore(opened.database, 'file');
  opened.close();
  const owner = await startEventOwner({ ...noRealHome(stateDir), stateDir, configDir, tickMs: 60_000 });
  try {
    // At a terminal: the kind and the budget are approved there, and the audit line says so.
    const typed = await cli(['judge', 'setup', 'local-endpoint', '--url', 'http://127.0.0.1:11434'], {
      stateDir,
      tty: true,
    });
    assert.equal(typed.code, 0, typed.stderr);
    const core = openCore({ pathOverrides: { stateDir, configDir } });
    const disclosures = (await core.approvals.list()).flatMap((entry) =>
      entry.form === 'v2' && entry.record.kind === 'disclosure' ? [entry.record] : [],
    );
    assert.equal(disclosures.length, 2, 'the budget and the kind');
    for (const approval of disclosures) assert.equal((approval as { approvedVia?: string }).approvedVia, 'terminal');
    const setups = (await core.audit.tail({ limit: 50 })).filter((line) => line.operation === 'events.judgeSetup');
    assert.equal(setups.at(-1)?.ids?.approvedBy, 'terminal');
    // On Windows and Linux, which attest nothing, a setup is the terminal's: refused, with the words to type there,
    // before the owner is asked (second look of the 0.33.0 security review).
    const unattested = await cli(['--json', 'judge', 'setup', 'local-endpoint', '--url', 'http://[::1]:8081'], {
      stateDir,
      desktopOrigin: async () => ({ ok: false, reason: 'unattested-platform' }),
    });
    assert.equal(unattested.code, APPROVAL_EXIT, unattested.stderr);
    assert.match(unattested.stderr, /at your terminal, with the event service's judge setup local-endpoint/u);
    // From the attested app: the result says which — the test build or the release — and its enablements are the app's.
    // The test build speaks for its own test profile only: its folders together, its event service's state folder marked.
    await writeFile(join(stateDir, TEST_PROFILE_MARKER), '');
    for (const [origin, approvedBy, port] of [
      [{ ok: true, build: 'test', identifier: 'com.cueplusplus.agentcomms.test' }, 'desktop-app (test build)', 8080],
      [{ ok: true, build: 'release', identifier: 'com.cueplusplus.agentcomms' }, 'desktop-app', 8082],
    ] as const) {
      const ran = await cli(
        ['--config-dir', configDir, '--json', 'judge', 'setup', 'local-endpoint', '--url', `http://[::1]:${port}`],
        { stateDir, desktopOrigin: async () => origin as DesktopOrigin },
      );
      assert.equal(ran.code, 0, ran.stderr);
      assert.equal((JSON.parse(ran.stdout) as { approvedBy: string }).approvedBy, approvedBy);
    }
  } finally {
    await owner.stop();
  }
});

test('judge setup refuses a local model server that is not on this machine, before it reaches the owner', async () => {
  for (const url of [
    'http://192.168.1.20:11434',
    'http://localhost:11434',
    'https://127.0.0.1:11434',
    'http://127.0.0.1',
    'http://127.0.0.1:11434/api/generate',
    'http://user@127.0.0.1:11434',
    'http://127.0.0.1:11434/?q=1',
    'http://[::2]:11434',
    'http://8.8.8.8:11434',
  ]) {
    assert.throws(() => localSetupEndpoint(url), /local model server's URL/u, url);
    const ran = await cli(['judge', 'setup', 'local-endpoint', '--url', url]);
    assert.equal(ran.code, USAGE_EXIT, url);
    assert.match(ran.stderr, /127\.0\.0\.1:<port>/u, url);
  }
  assert.deepEqual(localSetupEndpoint('http://127.0.0.1:11434'), {
    endpoint: 'http://127.0.0.1:11434/v1/systemone',
    address: '127.0.0.1',
  });
  assert.deepEqual(localSetupEndpoint('http://[::1]:8080/v1/systemone'), {
    endpoint: 'http://[::1]:8080/v1/systemone',
    address: '::1',
  });
  for (const args of [
    ['judge', 'setup', 'laya'],
    ['judge', 'setup', 'typesafe', '--provider', 'someone-else'],
    // Linear keeps a key beside the AI providers, but it serves no judge.
    ['judge', 'setup', 'typesafe', '--provider', 'linear'],
    ['judge', 'setup', 'typesafe', '--url', 'http://127.0.0.1:11434'],
    ['judge', 'setup', 'local-endpoint', '--url', 'http://127.0.0.1:11434', '--provider', 'openrouter'],
    ['provider', 'key', 'set', 'someone-else'],
  ]) {
    const ran = await cli(args, { stdin: `${OPENROUTER_KEY}\n` });
    assert.equal(ran.code, USAGE_EXIT, args.join(' '));
  }
  // A key is never taken from argv: the command has no argument for one.
  const extra = await cli(['provider', 'key', 'set', 'openrouter', OPENROUTER_KEY]);
  assert.notEqual(extra.code, 0);
});

async function filesBelow(directory: string, skip: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path, skip)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

test('judge setup sets Jev up and turns it on in one step, idempotently, from keys kept per provider', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-setup-');
  const configDir = await emptyConfigDir(stateDir);
  // The events-only file backend, so no test writes to this Mac's keychain.
  const opened = await openEventDatabase({ stateDir });
  await selectEventSecretStore(opened.database, 'file');
  opened.close();
  const owner = await startEventOwner({ ...noRealHome(stateDir), stateDir, configDir, tickMs: 60_000 });
  const outputs: string[] = [];
  const ok = async (args: readonly string[], stdin?: string) => {
    const ran = await cli(['--json', ...args], { stateDir, ...(stdin === undefined ? {} : { stdin }) });
    outputs.push(ran.stdout, ran.stderr);
    assert.equal(ran.code, 0, `${args.join(' ')}: ${ran.stderr}`);
    return JSON.parse(ran.stdout) as Record<string, unknown>;
  };
  const kinds = async () =>
    Object.fromEntries(
      ((await ok(['judge', 'kinds', 'list'])) as unknown as { kind: string; state: string }[]).map((entry) => [
        entry.kind,
        entry.state,
      ]),
    );
  try {
    assert.deepEqual(await ok(['provider', 'list']), {
      providers: [
        { id: 'typesafe', name: 'TypeSafe', hasKey: false },
        { id: 'openrouter', name: 'OpenRouter', hasKey: false },
        { id: 'anthropic', name: 'Anthropic', hasKey: false },
        { id: 'linear', name: 'Linear', hasKey: false },
      ],
    });

    // Without the provider's key nothing is made or turned on.
    const missing = await cli(['judge', 'setup', 'typesafe', '--provider', 'openrouter'], { stateDir });
    assert.equal(missing.code, CONFIG_EXIT, missing.stderr);
    assert.match(missing.stderr, /no OpenRouter key yet: add one in Settings → AI providers/u);
    assert.equal((await kinds()).typesafe, 'disabled');
    assert.deepEqual(await ok(['judges', 'list']), []);

    // The key arrives on stdin, as the app sends it, and is never printed.
    assert.deepEqual(await ok(['provider', 'key', 'set', 'openrouter'], `${OPENROUTER_KEY}\n`), {
      provider: 'openrouter',
      hasKey: true,
      judges: 0,
    });
    const listed = (await ok(['provider', 'list'])) as { providers: { id: string; hasKey: boolean }[] };
    assert.deepEqual(
      listed.providers.map((entry) => [entry.id, entry.hasKey]),
      [
        ['typesafe', false],
        ['openrouter', true],
        ['anthropic', false],
        ['linear', false],
      ],
    );

    const first = await ok(['judge', 'setup', 'typesafe', '--provider', 'openrouter']);
    assert.deepEqual(first, {
      kind: 'typesafe',
      enabled: true,
      enabledNow: true,
      judge: {
        judgeId: 'jev',
        version: 1,
        provider: 'openrouter',
        model: 'typesafe/jev-1.14',
        endpoint: 'https://openrouter.ai/api/v1/systemone',
        created: true,
      },
      budget: {
        version: 1,
        approvedNow: true,
        global: { callsPerRollingHour: 60, inputTokensPerRolling30Days: 1_000_000, concurrency: 2 },
        provider: {
          provider: 'openrouter',
          callsPerRollingHour: 60,
          inputTokensPerRolling30Days: 1_000_000,
          concurrency: 2,
        },
      },
      key: 'stored',
      destination:
        "Messages your workflows choose are sent to OpenRouter (openrouter.ai), which passes them to TypeSafe's Jev to be judged.",
      approvedBy: 'desktop-app',
    });
    assert.equal((await kinds()).typesafe, 'enabled');

    // The enablements are D2's own disclosure approvals, approved through the app channel and used.
    const core = openCore({ pathOverrides: { stateDir, configDir } });
    const disclosures = (await core.approvals.list()).flatMap((entry) =>
      entry.form === 'v2' && entry.record.kind === 'disclosure' ? [entry.record] : [],
    );
    assert.equal(disclosures.length, 2, 'the budget and the kind');
    for (const approval of disclosures) {
      assert.equal(approval.state, 'used');
      assert.equal((approval as { approvedVia?: string }).approvedVia, 'app');
    }
    const audit = await core.audit.tail({ limit: 50 });
    const setupLines = audit.filter((line) => line.operation === 'events.judgeSetup');
    assert.equal(setupLines.at(-1)?.outcome, 'ok');
    assert.equal(setupLines.at(-1)?.ids?.approvedBy, 'desktop-app');
    assert.equal(setupLines.at(-1)?.ids?.judgeId, 'jev');

    // Again: nothing new, nothing approved again.
    const again = await ok(['judge', 'setup', 'typesafe', '--provider', 'openrouter']);
    assert.equal(again.enabledNow, false);
    assert.equal((again.judge as { created: boolean; version: number }).created, false);
    assert.equal((again.judge as { version: number }).version, 1);
    assert.equal((again.budget as { approvedNow: boolean }).approvedNow, false);
    assert.equal(again.key, 'unchanged');

    // A replaced key reaches the judge at once; setting up again then has nothing to change.
    assert.deepEqual(await ok(['provider', 'key', 'set', 'openrouter'], OPENROUTER_KEY_2), {
      provider: 'openrouter',
      hasKey: true,
      judges: 1,
    });
    assert.equal((await ok(['judge', 'setup', 'typesafe', '--provider', 'openrouter'])).key, 'unchanged');

    // Changing provider is a new judge version, with the budget's ceiling for that provider added and approved.
    await ok(['provider', 'key', 'set', 'typesafe'], `${TYPESAFE_KEY}\r\n`);
    const native = await ok(['judge', 'setup', 'typesafe']);
    assert.deepEqual(native.judge, {
      judgeId: 'jev',
      version: 2,
      provider: 'typesafe',
      model: 'jev-1.13.0',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      created: true,
    });
    assert.equal((native.budget as { version: number; approvedNow: boolean }).version, 2);
    assert.equal((native.budget as { approvedNow: boolean }).approvedNow, true);
    assert.equal(native.enabledNow, false);
    assert.equal(native.key, 'stored');

    // Anthropic's key (0.33.0 design §3.3) is Analyse's alone: it is kept beside the others, serves no Jev judge, and
    // Jev cannot be set up on it.
    assert.deepEqual(await ok(['provider', 'key', 'set', 'anthropic'], `${ANTHROPIC_KEY}\n`), {
      provider: 'anthropic',
      hasKey: true,
      judges: 0,
    });
    const anthropicJev = await cli(['judge', 'setup', 'typesafe', '--provider', 'anthropic'], { stateDir });
    assert.equal(anthropicJev.code, USAGE_EXIT, anthropicJev.stderr);
    assert.deepEqual(await ok(['provider', 'key', 'remove', 'anthropic']), {
      provider: 'anthropic',
      hasKey: false,
      judges: 0,
    });
    const unknownProvider = await cli(['provider', 'key', 'set', 'someone-else'], { stateDir, stdin: 'fake-x\n' });
    assert.equal(unknownProvider.code, USAGE_EXIT, unknownProvider.stderr);
    assert.match(unknownProvider.stderr, /the provider is typesafe, openrouter, anthropic or linear/u);

    // A local model server: its URL, checked again by the owner, and a new version when it changes.
    const local = await ok(['judge', 'setup', 'local-endpoint', '--url', 'http://127.0.0.1:11434']);
    assert.equal(local.enabledNow, true);
    assert.equal(local.key, 'none');
    assert.deepEqual(local.judge, {
      judgeId: 'local-model',
      version: 1,
      provider: 'ollama',
      model: 'nimble',
      endpoint: 'http://127.0.0.1:11434/v1/systemone',
      created: true,
    });
    assert.equal(local.destination, 'A model server on this machine. Nothing leaves it.');
    const moved = await ok(['judge', 'setup', 'local-endpoint', '--url', 'http://[::1]:8080']);
    assert.equal((moved.judge as { version: number }).version, 2);
    assert.equal((moved.judge as { endpoint: string }).endpoint, 'http://[::1]:8080/v1/systemone');
    assert.equal(moved.enabledNow, false);

    // Removing a key takes it from the provider and from the judges it serves.
    assert.deepEqual(await ok(['provider', 'key', 'remove', 'openrouter']), {
      provider: 'openrouter',
      hasKey: false,
      judges: 1,
    });
    assert.equal(
      ((await ok(['provider', 'list'])) as { providers: { id: string; hasKey: boolean }[] }).providers.find(
        (entry) => entry.id === 'openrouter',
      )?.hasKey,
      false,
    );
    // The owner takes these only from the person's setup origin: any other client is refused, and audited.
    const other = new EventControlClient({ stateDir, clientName: 'events-cli' });
    for (const [operation, args] of [
      ['provider-key-set', { provider: 'openrouter', hidden: OPENROUTER_KEY }],
      ['provider-key-remove', { provider: 'typesafe' }],
      ['judge-setup', { kind: 'typesafe' }],
    ] as const)
      await assert.rejects(other.request(operation, args), (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'APPROVAL_REQUIRED', operation);
        return true;
      });
    assert.equal(
      ((await ok(['provider', 'list'])) as { providers: { id: string; hasKey: boolean }[] }).providers.find(
        (entry) => entry.id === 'typesafe',
      )?.hasKey,
      true,
      'a refused removal removed nothing',
    );
    // The old label of the person's setup is no origin either.
    const unlabelled = new EventControlClient({ stateDir, clientName: 'person-setup' });
    await assert.rejects(unlabelled.request('provider-key-remove', { provider: 'typesafe' }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'APPROVAL_REQUIRED');
      return true;
    });
    // At an interactive terminal the key is the person's hidden input, and the audit says it was set at a terminal.
    const typed = await cli(['provider', 'key', 'set', 'typesafe'], {
      stateDir,
      tty: true,
      readSecret: async () => TYPESAFE_KEY,
    });
    assert.equal(typed.code, 0, typed.stderr);
    outputs.push(typed.stdout, typed.stderr);
    // On Windows and Linux, which attest nothing, removing a key is the terminal's: refused, nothing removed.
    const unattested = await cli(['--json', 'provider', 'key', 'remove', 'typesafe'], {
      stateDir,
      desktopOrigin: async () => ({ ok: false, reason: 'unattested-platform' }),
    });
    assert.equal(unattested.code, APPROVAL_EXIT, unattested.stderr);
    assert.match(unattested.stderr, /at your terminal, with the event service's provider key remove typesafe/u);
    assert.equal(
      ((await ok(['provider', 'list'])) as { providers: { id: string; hasKey: boolean }[] }).providers.find(
        (entry) => entry.id === 'typesafe',
      )?.hasKey,
      true,
      'an unattested removal removed nothing',
    );
    // The local test build, for its own test profile, is said to be the test build's: never the release app's.
    const typedAgain = await cli(['provider', 'key', 'set', 'typesafe'], {
      stateDir,
      tty: true,
      readSecret: async () => TYPESAFE_KEY,
    });
    assert.equal(typedAgain.code, 0, typedAgain.stderr);
    await writeFile(join(stateDir, TEST_PROFILE_MARKER), '');
    const fromTestBuild = await cli(['--config-dir', configDir, '--json', 'provider', 'key', 'remove', 'typesafe'], {
      stateDir,
      desktopOrigin: async () => ({ ok: true, build: 'test', identifier: 'com.cueplusplus.agentcomms.test' }),
    });
    assert.equal(fromTestBuild.code, 0, fromTestBuild.stderr);
    const keyLines = (await openCore({ pathOverrides: { stateDir, configDir } }).audit.tail({ limit: 100 })).filter(
      (line) => line.operation === 'events.providerKeySet' || line.operation === 'events.providerKeyRemove',
    );
    const lastSet = keyLines.filter((line) => line.operation === 'events.providerKeySet').at(-1);
    assert.equal(lastSet?.ids?.approvedBy, 'terminal');
    assert.equal(lastSet?.surface, 'cli');
    const removes = keyLines.filter((line) => line.operation === 'events.providerKeyRemove');
    assert.equal(
      removes.some((line) => line.ids?.approvedBy === 'desktop-app (unattested)' && line.outcome === 'ok'),
      false,
      'no unattested removal was made',
    );
    assert.equal(removes.at(-1)?.ids?.approvedBy, 'desktop-app (test build)');
    assert.equal(removes.at(-1)?.surface, 'app');
    // `judge kind disable` stays the off switch.
    await ok(['judge', 'kind', 'disable', 'typesafe']);
    assert.equal((await kinds()).typesafe, 'disabled');
  } finally {
    await owner.stop();
  }
  try {
    // No key reached any output, the audit log, the database or its journal: only the events-only secret store.
    const keys = [OPENROUTER_KEY, OPENROUTER_KEY_2, TYPESAFE_KEY, ANTHROPIC_KEY];
    for (const output of outputs)
      for (const key of keys) assert.ok(!output.includes(key), `an output names a provider key: ${output}`);
    for (const file of await filesBelow(stateDir, (name) => name === 'secrets')) {
      const bytes = await readFile(file);
      for (const key of keys)
        assert.ok(!bytes.includes(Buffer.from(key)), `${file.slice(stateDir.length)} holds a provider key`);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
