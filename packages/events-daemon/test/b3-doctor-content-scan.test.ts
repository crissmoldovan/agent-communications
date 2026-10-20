import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { run as runEventsCli } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import {
  DOCTOR_REPORT_V1_SCHEMA_VERSION,
  projectB3Doctor,
  projectE9Doctor,
} from '../src/runtime/b3-doctor-projection.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const FORBIDDEN = [
  'DOCTOR_SECRET_MARKER',
  'doctor-secret-marker',
  'doctor-reference-marker',
  'doctor-fingerprint-marker',
  'https://doctor.invalid/path?component=marker',
  'doctor-alias-marker',
  'doctor-raw-tuple-marker',
  'doctor-provider-response-marker',
  'doctor-stack-marker',
] as const;

test('B3 doctor process and file-sink mutation cases declare complete overlay inputs', async () => {
  const manifest = JSON.parse(await readFile(new URL('./b3-guard-manifests/doctor.json', import.meta.url), 'utf8')) as {
    readonly cases?: readonly { readonly case?: unknown; readonly overlayInputs?: unknown }[];
  };
  const expected = [
    'package.json',
    'capabilities.json',
    'packages/*/package.json',
    'scripts/**',
    'packages/events-daemon/src/operations/contracts/doctor-v1.schema.json',
    'packages/events-daemon/src/operations/contracts/doctor-v2.schema.json',
  ];
  const names = new Set([
    'doctor-scans-cli-stderr-for-content',
    'doctor-scans-process-log-for-content',
    'doctor-scans-audit-for-content',
  ]);
  const cases = (manifest.cases ?? []).filter(
    (entry): entry is { readonly case: string; readonly overlayInputs?: unknown } =>
      typeof entry.case === 'string' && names.has(entry.case),
  );
  assert.deepEqual(cases.map((entry) => entry.case).sort(), [...names].sort());
  for (const entry of cases)
    assert.deepEqual(
      entry.overlayInputs,
      expected,
      `${entry.case} snapshots the CLI, audit, and package filesystem inputs`,
    );
});

/** Captures the owner's real stderr process log while it serves doctor; it never writes a synthetic log record. */
async function captureOwnerProcessLog<T>(
  work: () => Promise<T>,
): Promise<{ readonly value: T; readonly log: string[] }> {
  const log: string[] = [];
  const stream = process.stderr;
  const original = stream.write;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    log.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
  }) as typeof stream.write;
  try {
    return { value: await work(), log };
  } finally {
    stream.write = original;
  }
}

async function runDoctorCli(
  stateDir: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const packageRoot = join(import.meta.dirname, '..');
  const preload = join(packageRoot, '..', '..', 'test', 'helpers', 'loopback-seal-preload.mjs');
  const entry = join(packageRoot, 'src', 'cli.ts');
  const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        entry,
        '--state-dir',
        stateDir,
        '--json',
        'doctor',
      ],
      { cwd: packageRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** A writable stream that keeps exactly what the CLI wrote to it, synchronously. */
function capturedStream(): { readonly stream: Writable; readonly text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}

/**
 * Runs the production Commander program in this process with its own stdout and stderr. The child-process run above
 * proves the binary's wiring; this run is the one a mutant of the program reaches, because a mutation overlay
 * replaces modules in this process and a freshly spawned CLI loads the unmutated source.
 */
async function runDoctorCliInProcess(
  stateDir: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdout = capturedStream();
  const stderr = capturedStream();
  const code = await runEventsCli(['--state-dir', stateDir, '--json', 'doctor'], {
    streams: { stdin: new PassThrough(), stdout: stdout.stream, stderr: stderr.stream },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Reads the files AuditLog actually created under this test's state home; absent audit files are an empty sink. */
async function actualAuditTrail(stateDir: string): Promise<string> {
  const directory = join(stateDir, 'audit');
  try {
    const files = (await readdir(directory)).filter((file) => /^\d{4}-\d{2}\.jsonl$/u.test(file)).sort();
    return (await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))).join('');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function sinksWithForbiddenContent(
  sinks: Readonly<Record<string, string>>,
  prohibited: readonly string[] = FORBIDDEN,
): string[] {
  return Object.entries(sinks)
    .filter(([, output]) => prohibited.some((marker) => output.includes(marker)))
    .map(([sink]) => sink);
}

test('B3 doctor projection has a closed content-free data surface', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-projection-scan-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const document = JSON.stringify({
        ruleId: 'rule-doctor-projection-scan',
        version: 1,
        source: { channel: 'gmail', accountIds: ['ibx_DOCTORSCANNER'], options: { alias: FORBIDDEN[4] } },
        event: { type: 'gmail.message.received', version: 1 },
        condition: { sender: 'doctor-sender-marker', rawTuple: FORBIDDEN[5] },
        mapping: { providerResponse: FORBIDDEN[6], stack: FORBIDDEN[7] },
        targets: [],
        subscribers: [],
        judges: [],
      });
      store.database
        .prepare(
          `INSERT INTO rule_versions
           (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
           VALUES ('rule-doctor-projection-scan@1', 'rule-doctor-projection-scan', 1, ?, 'digest', 'active', 'approval-doctor-scan', 'activation-doctor-scan', 1)`,
        )
        .run(document);
      store.database
        .prepare(
          "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-doctor-projection-scan', 1, 'activation-doctor-scan', 1)",
        )
        .run();
      store.database
        .prepare(
          `INSERT INTO rule_activation_points
           (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
           VALUES ('activation-doctor-scan', 'rule-doctor-projection-scan', 1, 'gmail', 'ibx_DOCTORSCANNER', 'mailbox', X'01', 1)`,
        )
        .run();
      store.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
        .run(
          'target-doctor-scan@1',
          'target-doctor-scan',
          JSON.stringify({ ...Object.fromEntries(FORBIDDEN.map((value) => [value, value])) }),
          'digest',
        );
      const report = await projectB3Doctor({
        database: store.database,
        installationId: store.installationId,
        lifecycle: { enabled: false, paused: false, switchGeneration: 0 },
        protocolVersions: [1],
        ports: { assertObjectSecretReady: async () => undefined } as never,
        config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async () => null,
      });
      const serialized = JSON.stringify(report);
      for (const forbidden of ['doctor-sender-marker', ...FORBIDDEN])
        assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.equal(report.schemaVersion, DOCTOR_REPORT_V1_SCHEMA_VERSION);
      const phaseEReport = await projectE9Doctor({
        database: store.database,
        installationId: store.installationId,
        lifecycle: { enabled: false, paused: false, switchGeneration: 0 },
        protocolVersions: [1],
        ports: { assertObjectSecretReady: async () => undefined } as never,
        config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async () => null,
      });
      assert.deepEqual(
        phaseEReport.judgeBoundary,
        [{ kind: 'laya', code: 'E2_REQUIRED', phase: 'E2' }],
        'the Phase-E projection is a v1 semantic superset with only Laya still unavailable',
      );
      const v1Schema = JSON.parse(
        await readFile(join(import.meta.dirname, '../src/operations/contracts/doctor-v1.schema.json'), 'utf8'),
      ) as Record<string, unknown>;
      const v2Schema = JSON.parse(
        await readFile(join(import.meta.dirname, '../src/operations/contracts/doctor-v2.schema.json'), 'utf8'),
      ) as Record<string, unknown>;
      const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      ajv.addSchema(v1Schema);
      const validatesV2 = ajv.compile(v2Schema);
      assert.equal(validatesV2(phaseEReport), true, JSON.stringify(validatesV2.errors));
      const { judge: _judge, ...v1Projection } = phaseEReport;
      const restoredV1 = { ...v1Projection, schemaVersion: 'doctor-v1' as const };
      const validatesV1 = ajv.getSchema(v1Schema.$id as string);
      assert.ok(validatesV1, 'the pinned v1 schema remains addressable');
      assert.equal(validatesV1(restoredV1), true, JSON.stringify(validatesV1.errors));
      assert.deepEqual(restoredV1, {
        ...report,
        judgeBoundary: [{ kind: 'laya', code: 'E2_REQUIRED', phase: 'E2' }],
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor serializes no sender, secret, reference, fingerprint, URL, alias, tuple, provider response, or stack on every result, output, log, and audit sink', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-b3-doctor-scan-');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const document = JSON.stringify({
        source: {
          alias: FORBIDDEN[4],
          rawTuple: FORBIDDEN[5],
          providerResponse: FORBIDDEN[6],
        },
        target: {
          url: FORBIDDEN[3],
          secret: FORBIDDEN[0],
          reference: FORBIDDEN[1],
          fingerprint: FORBIDDEN[2],
        },
        sender: { text: 'doctor-sender-marker', stack: FORBIDDEN[7] },
      });
      store.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
        .run('target-doctor-scan@1', 'target-doctor-scan', document, 'd'.repeat(64));
      store.database
        .prepare(
          `INSERT INTO activation_intents
           (id, kind, document, digest, effect, required_points, acquisition_scopes, status, failure_code, created_at, updated_at)
           VALUES ('intent-doctor-content-marker', 'rule', '{}', 'digest', '{}', '[]', '[]', 'failed', 'DOCTOR_SECRET_MARKER', 1, 1)`,
        )
        .run();
    } finally {
      store.close();
    }
    try {
      owner = await startEventOwner({ stateDir, configDir: await emptyConfigDir(stateDir), tickMs: 60_000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip(
          'EPERM: the development sandbox blocks the owner Unix listener; the coordinator runs this doctor surface proof outside it',
        );
        return;
      }
      throw error;
    }

    const captured = await captureOwnerProcessLog(async () => {
      const cli = await runDoctorCli(stateDir);
      assert.equal(cli.code, 0, cli.stderr);
      const inProcess = await runDoctorCliInProcess(stateDir);
      assert.equal(inProcess.code, 0, inProcess.stderr);
      assert.equal(
        (JSON.parse(inProcess.stdout) as { readonly schemaVersion?: unknown }).schemaVersion,
        'doctor-v3',
        'the in-process CLI run reached the owner and printed the doctor report',
      );
      assert.deepEqual(
        (JSON.parse(inProcess.stdout) as { readonly judgeBoundary?: unknown }).judgeBoundary,
        [],
        'the live E2 doctor (v3) has no judge kind left behind a phase boundary',
      );

      const { server } = await createEventsMcpServer({ stateDir });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'b3-doctor-content-scan', version: '0' });
      try {
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        const result = (await client.callTool({ name: 'events_doctor', arguments: {} })) as {
          readonly structuredContent: unknown;
          readonly content: readonly { readonly type: string; readonly text?: string }[];
        };
        assert.equal(JSON.stringify(result.structuredContent), result.content[0]?.text);
        assert.equal((result.structuredContent as { readonly schemaVersion?: unknown }).schemaVersion, 'doctor-v3');
        assert.deepEqual(
          (result.structuredContent as { readonly judgeBoundary?: unknown }).judgeBoundary,
          [],
          'the MCP result is the same doctor-v3 report, with no judge kind left behind a boundary',
        );
        return { cli, inProcess, mcp: JSON.stringify(result) };
      } finally {
        await Promise.all([client.close(), server.close()]);
      }
    });
    const sinks = {
      cliStdout: captured.value.cli.stdout,
      cliStderr: captured.value.cli.stderr,
      cliInProcessStdout: captured.value.inProcess.stdout,
      cliInProcessStderr: captured.value.inProcess.stderr,
      mcp: captured.value.mcp,
      processLog: captured.log.join(''),
      auditTrail: await actualAuditTrail(stateDir),
    };
    assert.deepEqual(
      sinksWithForbiddenContent(sinks, ['doctor-sender-marker', ...FORBIDDEN]),
      [],
      'the real doctor result/output/log/audit boundaries are content-free',
    );
  } finally {
    await owner?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
