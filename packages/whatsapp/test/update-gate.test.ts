import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { openCore, updateCheckPath, updatePause } from '@agentcomms/core';
import { coreInline } from './support/handoffs.ts';
import { newHarness, tempDir } from './support/harness.ts';
import { ACCOUNT, connect } from './support/surfaces.ts';

/*
 * The update notice on WhatsApp (design 2026-10-16, U1): this package has no network code, so it never asks the
 * registry — it imports the reader alone, and says an update is out once any other server or command on the machine
 * has found one. Nothing is refused for being behind. Shown with the network cut off at the socket, DNS, TLS, `fetch` and process creation, as
 * `no-network.test.ts` cuts it; and in the bundle as it ships, which carries the reader and not the checker.
 */

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

test('with the network cut off, an update in the file is the notice of the first tool result and of a command, and stops nothing', async () => {
  const harness = await newHarness({ env: { AGENT_COMMS_UPDATE_CHECK: 'on' } });
  await harness.ready();
  const core = openCore({ env: harness.env });
  // A day stale on purpose: anything that could ask the registry would ask now. WhatsApp must not.
  const checked = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
  mkdirSync(core.paths.stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(core.paths.stateDir),
    JSON.stringify({ lastChecked: checked, latest: '99.0.0', behind: true }),
  );

  const attempts: string[] = [];
  const refuse = (what: string) =>
    function refused(): never {
      attempts.push(what);
      throw new Error(`network attempted: ${what}`);
    };
  const saved = {
    connect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    lookup: dns.lookup,
    fetch: globalThis.fetch,
    spawn: childProcess.spawn,
    execFile: childProcess.execFile,
  };
  net.Socket.prototype.connect = refuse('net.Socket.connect') as typeof net.Socket.prototype.connect;
  tls.connect = refuse('tls.connect') as typeof tls.connect;
  dns.lookup = refuse('dns.lookup') as unknown as typeof dns.lookup;
  globalThis.fetch = refuse('fetch') as typeof fetch;
  childProcess.spawn = refuse('child_process.spawn') as typeof childProcess.spawn;
  childProcess.execFile = refuse('child_process.execFile') as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  try {
    const { call, close } = await connect(harness);
    try {
      const status = await call('whatsapp_status', {});
      assert.notEqual(status.isError, true, JSON.stringify(status.structuredContent));
      assert.equal((status.structuredContent as { update?: unknown }).update, undefined, 'its doctor carried it');
      const chats = await call('whatsapp_chats', { account: ACCOUNT });
      assert.notEqual(chats.structuredContent.error?.code, 'UPDATE_REQUIRED');
      assert.equal(
        (chats.structuredContent as { update?: unknown }).update,
        'agent-communications 99.0.0 is out; say "update" when it suits you.',
      );
      const again = await call('whatsapp_chats', { account: ACCOUNT });
      assert.equal((again.structuredContent as { update?: unknown }).update, undefined, 'said twice');
    } finally {
      await close();
    }
    // Every registration of WhatsApp's server here names the latest — the file says so, and no network is needed to
    // read it: restart the client, not update.
    const record = { lastChecked: checked, latest: '99.0.0', behind: true };
    writeFileSync(
      updateCheckPath(core.paths.stateDir),
      JSON.stringify({ ...record, current: { registered: ['whatsapp'], global: [] } }),
    );
    const restart = await connect(harness);
    try {
      const chats = await restart.call('whatsapp_chats', { account: ACCOUNT });
      assert.match(
        String((chats.structuredContent as { update?: unknown }).update),
        /is installed; restart the client/,
      );
    } finally {
      await restart.close();
    }
    writeFileSync(updateCheckPath(core.paths.stateDir), JSON.stringify(record));
    const ran = await harness.cli(['chats', '--account', ACCOUNT, '--json']);
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.stderr, /^agent-communications 99\.0\.0 is out \(this is /m);
    // Core's command, as this package finds core through its own dependency on it: never a bare `agentcomms`.
    assert.ok(ran.stderr.includes(coreInline(harness.env, ['update'])), ran.stderr);
    assert.equal((await harness.cli(['status', '--json'])).code, 0);
    // WhatsApp's package installed globally at the latest, and this copy older: told to run the installed one.
    writeFileSync(
      updateCheckPath(core.paths.stateDir),
      JSON.stringify({ ...record, current: { registered: [], global: ['whatsapp'] } }),
    );
    const older = await harness.cli(['chats', '--account', ACCOUNT, '--json']);
    assert.equal(older.code, 0, older.stdout);
    assert.match(older.stderr, /is installed; this WhatsApp CLI is .*: run it from the installed one\./);
    writeFileSync(updateCheckPath(core.paths.stateDir), JSON.stringify(record));

    // A pause, asked anywhere on the machine — here through core’s own operation — holds for WhatsApp too. The file
    // is written again without the day’s notice, so its once-a-day spacing is not what keeps it quiet.
    writeFileSync(updateCheckPath(core.paths.stateDir), JSON.stringify(record));
    await updatePause(core, { days: 7 });
    const quiet = await harness.cli(['chats', '--account', ACCOUNT, '--json']);
    assert.equal(quiet.code, 0);
    assert.doesNotMatch(quiet.stderr, /is out/);
  } finally {
    net.Socket.prototype.connect = saved.connect;
    tls.connect = saved.tlsConnect;
    dns.lookup = saved.lookup;
    globalThis.fetch = saved.fetch;
    childProcess.spawn = saved.spawn;
    childProcess.execFile = saved.execFile;
    syncBuiltinESMExports();
  }
  assert.deepEqual(attempts, [], 'nothing reached for the network');
  const record = JSON.parse(readFileSync(updateCheckPath(core.paths.stateDir), 'utf8')) as { lastChecked: string };
  assert.equal(record.lastChecked, checked, 'WhatsApp did not check, stale as the file was');
});

test('a flag-pinned WhatsApp run reads update state from the pinned directory and starts no child', async () => {
  const harness = await newHarness({ env: { AGENT_COMMS_UPDATE_CHECK: 'on' } });
  const ambient = tempDir('agent-whatsapp-update-ambient-');
  const pinned = openCore({ env: harness.env });
  mkdirSync(pinned.paths.stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(pinned.paths.stateDir),
    JSON.stringify({ lastChecked: new Date().toISOString(), latest: '99.0.0', behind: true }),
  );
  const spawn = childProcess.spawn;
  const attempts: string[] = [];
  childProcess.spawn = ((..._args: unknown[]) => {
    attempts.push('child_process.spawn');
    throw new Error('WhatsApp must not start an update child');
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const { configDir, stateDir, dataDir, secretsDir, downloadsDir } = pinned.paths;
    const result = await harness.cli(
      [
        '--config-dir',
        configDir,
        '--state-dir',
        stateDir,
        '--data-dir',
        dataDir,
        '--secrets-dir',
        secretsDir,
        '--downloads-dir',
        downloadsDir,
        'chats',
        '--account',
        ACCOUNT,
        '--json',
      ],
      {
        env: {
          ...harness.env,
          AGENT_COMMS_CONFIG_DIR: join(ambient, 'config'),
          AGENT_COMMS_STATE_DIR: join(ambient, 'state'),
          AGENT_COMMS_DATA_DIR: join(ambient, 'data'),
          HOME: join(ambient, 'home'),
          USERPROFILE: join(ambient, 'home'),
        },
      },
    );
    // Not stopped: the command ran to its own answer — there is no account in these folders — and the notice is the
    // pinned directory's file, not the ambient one's, which holds nothing.
    assert.equal((result.json().error as { code?: string }).code, 'NOT_FOUND', result.stdout + result.stderr);
    assert.match(result.stderr, /99\.0\.0 is out/);
  } finally {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
  }
  assert.deepEqual(attempts, []);
});

test('the bundle as it ships carries the update notice’s reader, and none of the checker', async () => {
  const { build } = await import('tsdown');
  const outDir = tempDir('agent-whatsapp-gate-bundle-');
  await build({
    config: false,
    cwd: PACKAGE,
    entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir,
    dts: false,
    noExternal: [/.*/],
    external: ['@napi-rs/keyring'],
    logLevel: 'silent',
  });
  const shipped = files(outDir)
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  assert.match(shipped, /update-check\.json/, 'the reader is there');
  // The notice's words: assembled from parts, so one phrase of them that is written whole.
  assert.match(shipped, /restart the client \(in Claude Code, \/mcp → Reconnect\) to use it/);
  for (const checker of [
    'checkForUpdates',
    'npmLatestVersion',
    'terminalUpdateHooks',
    'npmGlobalPackages',
    'claimUpdateCheck',
    'askUnderClaim',
    'runUpdateCheckChild',
    'updateCheckChildEntry',
    'updateCheckChildEnvironment',
    'UPDATE_CHECK_CHILD_COMMAND',
    'update-check-child',
    // A channel's hand-off to core's CLI (design 2026-10-22, P2): WhatsApp has no check to hand on.
    'coreUpdateCheckWords',
    'startCheckChild',
    // What reads and installs a verified release (P1, P3): a network path, which WhatsApp's bundle never reaches.
    'readVerifiedDeclaration',
    'downloadVerifiedTarball',
    'installVerifiedGlobal',
    'release-declarations.json',
  ]) {
    assert.ok(!shipped.includes(checker), `the bundle carries ${checker}`);
  }
});
