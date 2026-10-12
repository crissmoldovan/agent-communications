import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preparePackagedPayload } from './packaged-payload.mjs';

const root = new URL('../../../../', import.meta.url);
const desktop = new URL('../../', import.meta.url);

export async function auditPhaseSeams() {
  const { phaseSeam } = await import('../../src/screens/phase-seams.ts');
  assert.match(phaseSeam({ code: 'E_REQUIRED' }), /unavailable until Phase E/);
  assert.match(phaseSeam({ code: 'HOLDS_UNAVAILABLE' }), /unavailable until Phase E/);
  assert.match(phaseSeam({ code: 'E2_REQUIRED' }), /unavailable until Phase E2/);
  assert.match(phaseSeam({ code: 'E2_REQUIRED' }), /No runtime, model, download or worker is started/);
  assert.equal(phaseSeam(), null);
}

export async function runControlFlow({ binary: suppliedBinary } = {}) {
  const { controlVectors, startDaemonControlPeer } = await import('./fixtures/daemon-control-peer.mjs');
  const { noEgressSentinel } = await import('./fixtures/no-egress-sentinel.mjs');
  // Fail precisely before an expensive build if this environment cannot run the required local trap.
  const preflight = await noEgressSentinel();
  await preflight.close();
  const vectors = await controlVectors();
  const operations = [...new Set(vectors.map((row) => row.request.operation))].sort();
  const payload = suppliedBinary ? { binary: suppliedBinary, cleanup: async () => {} } : await preparePackagedPayload();
  const binary = payload.binary;
  const { mkdtemp, rm, chmod, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'desktop-full-')));
  await chmod(home, 0o700);
  let trap;
  let peer;
  let child;
  try {
    trap = await noEgressSentinel();
    if (process.platform !== 'win32') peer = await startDaemonControlPeer(vectors);
    const fixture = join(home, 'fixture.json');
    await writeFile(
      fixture,
      JSON.stringify({
        profile: peer?.profile ?? { executable: 'unreadable', stateDir: 'unreadable', configDir: 'unreadable' },
        requests: operations.map((operation) => vectors.find((row) => row.request.operation === operation).request),
      }),
      { mode: 0o600 },
    );
    child = spawn(binary, [], {
      cwd: desktop,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        TEMP: home,
        TMP: home,
        DESKTOP_PROBE_FULL_FIXTURE: fixture,
        DESKTOP_PROBE_PORT: String(trap.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The app's own words are the only diagnosis a failed packaged run has; keep a bounded tail of each stream.
    let stderrTail = '';
    child.stderr.setEncoding('utf8').on('data', (part) => {
      stderrTail = (stderrTail + part).slice(-4000);
    });
    const report = await new Promise((resolveReport, reject) => {
      let output = '';
      const diagnosis = () => `\nstdout: ${output.slice(-2000)}\nstderr: ${stderrTail}`;
      // A hang guard, not a speed bound: hosted runners start a cold release build slowly.
      const timeout = setTimeout(
        () => reject(new Error(`packaged full-production report deadline${diagnosis()}`)),
        120_000,
      );
      const fail = () => {
        clearTimeout(timeout);
        reject(new Error(`packaged full-production process unavailable${diagnosis()}`));
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.stdout.setEncoding('utf8').on('data', (part) => {
        output += part;
        const match = output.match(/desktop-probe:settings:2:[^\n]*:full-production,([^\r\n]+)/);
        if (match) {
          clearTimeout(timeout);
          resolveReport(match[1]);
        }
        if (output.length > 16384) {
          clearTimeout(timeout);
          reject(new Error('unexpected packaged probe output'));
        }
      });
    });
    trap.audit();
    if (process.platform === 'win32') {
      assert.equal(report, 'WINDOWS_CONTROL_UNAVAILABLE');
      return { unavailable: report, operations: [], adapterCalls: 0, nativeCalls: 0, egress: [] };
    }
    assert.equal(report, `${operations.length},adapter-renderer-native`);
    assert.deepEqual(
      peer.journal.map((row) => row.operation),
      operations,
    );
    return { operations, adapterCalls: operations.length, nativeCalls: peer.journal.length, egress: trap.requests };
  } finally {
    child?.kill();
    await peer?.close();
    await trap?.close();
    await rm(home, { recursive: true, force: true });
    await payload.cleanup();
  }
}

export async function runFullProduction() {
  const folder = process.env.DESKTOP_EVIDENCE_DIR
    ? pathToFileURL(`${resolve(process.env.DESKTOP_EVIDENCE_DIR)}/`)
    : new URL('test/evidence/', desktop);
  await mkdir(folder, { recursive: true });
  await writeFile(
    new URL('full-production.json', folder),
    `${JSON.stringify({ version: 1, platform: process.platform, complete: false, stage: 'control' })}\n`,
  );
  const payload = await preparePackagedPayload();
  try {
    await auditPhaseSeams();
    const evidence = await runControlFlow({ binary: payload.binary });
    await writeFile(
      new URL('full-production.json', folder),
      `${JSON.stringify({ version: 1, platform: process.platform, complete: false, stage: 'webviews', ...evidence })}\n`,
    );
    // Run the existing task-owned production proofs as one integration gate; never reimplement their authority model.
    for (const probe of ['no-egress', 'capabilities']) {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          new URL('test/helpers/loopback-seal-preload.mjs', root).href,
          // The entry is a path: node reads a `file:` string here as a relative file name.
          fileURLToPath(new URL('./production-probe.mjs', import.meta.url)),
          '--case',
          probe,
        ],
        {
          cwd: desktop,
          env: { ...process.env, DESKTOP_PROBE_BINARY: payload.binary },
          stdio: 'inherit',
          timeout: 1_200_000,
        },
      );
      assert.equal(result.status, 0, `${probe} production gate failed`);
    }
    const ownedProofs = [
      'app-approval-owner.test.mjs',
      'approval-renderer.test.tsx',
      'secret-trace.test.mjs',
      'secret-window.test.tsx',
      'screen-request.test.tsx',
      'purge-ui-orphans.test.tsx',
      'supervision-lifecycle.test.mjs',
      'screen-contract.test.tsx',
      'control-contract.test.ts',
    ];
    const owners = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--import',
        new URL('test/helpers/loopback-seal-preload.mjs', root).href,
        '--import',
        new URL('../helpers/tsx-register.mjs', import.meta.url).href,
        '--test',
        '--test-reporter=tap',
        ...ownedProofs.map((file) => fileURLToPath(new URL(`../${file}`, import.meta.url))),
      ],
      { cwd: root, env: { ...process.env, AGENTCOMMS_DESKTOP_NATIVE: '1' }, stdio: 'inherit', timeout: 1_200_000 },
    );
    assert.equal(owners.status, 0, 'task-owned integrated production proofs failed');
    const { buildEvidence, auditBundle } = await import('../../scripts/bundle-content-graph.mjs');
    const bundle = await buildEvidence();
    auditBundle(bundle);
    await writeFile(
      new URL('full-production.json', folder),
      `${JSON.stringify({ version: 1, platform: process.platform, complete: true, ...evidence, bundle }, null, 2)}\n`,
    );
  } finally {
    await payload.cleanup();
  }
}
