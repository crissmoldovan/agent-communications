import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertLoopbackSeal } from '../../../../../test/helpers/loopback-seal-preload.mjs';

export async function controlVectors() {
  const folder = new URL(
    '../../../../../packages/events-daemon/test/fixtures/b3-control-contract-v1/',
    import.meta.url,
  );
  const vectors = [];
  for (const file of (await readdir(folder)).sort()) {
    const document = JSON.parse(await readFile(new URL(file, folder), 'utf8'));
    for (const row of Array.isArray(document) ? document : [document]) {
      if (!row.result || row.request?.surface || row.request?.origin) continue;
      if (['approvalView', 'approve'].includes(row.request.operation)) continue;
      vectors.push(row);
    }
  }
  const schema = JSON.parse(
    await readFile(
      new URL(
        '../../../../../packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const expected = Object.entries(schema.$defs.resultsByOperation.$defs)
    .filter(
      ([operation, shape]) =>
        shape.$ref !== '#/$defs/secretCapabilityUnavailable' && !['approve', 'approvalView'].includes(operation),
    )
    .map(([operation]) => operation)
    .sort();
  assert.deepEqual(
    [...new Set(vectors.map((row) => row.request.operation))].sort(),
    expected,
    'incomplete native operation fixture inventory',
  );
  return vectors;
}

/** Scripted data only: framing, authentication and native validation remain production code. */
export async function startDaemonControlPeer(vectors) {
  assertLoopbackSeal();
  const { startControlServer } = await import('../../../../../packages/events-daemon/src/control/server.ts');
  const root = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'd-c7-')));
  const profile = {
    executable: join(root, 'agent-events'),
    stateDir: join(root, 'state'),
    configDir: join(root, 'config'),
  };
  let server;
  const journal = [];
  try {
    await chmod(root, 0o700);
    for (const path of [
      profile.stateDir,
      profile.configDir,
      join(profile.stateDir, 'events'),
      join(profile.stateDir, 'events/socket'),
    ])
      await mkdir(path, { mode: 0o700 });
    await writeFile(profile.executable, '', { mode: 0o700 });
    const endpoint = join(profile.stateDir, 'events/socket/control.sock');
    const token = '7'.repeat(64);
    server = await startControlServer({
      endpoint,
      token,
      verifyEndpoint: async () => {},
      handle: async (request) => {
        assert.deepEqual(Object.keys(request).sort(), [
          'args',
          'operation',
          'origin',
          'requestId',
          'session',
          'version',
        ]);
        assert.equal(request.version, 1);
        const vector = vectors.find(
          (row) => row.request.operation === request.operation && isDeepStrictEqual(row.request.args, request.args),
        );
        assert.ok(vector, `unexpected operation frame: ${request.operation}`);
        // No raw arguments, identities, token, secret material or provider strings enter persisted evidence.
        journal.push({
          operation: request.operation,
          argsDigest: createHash('sha256').update(JSON.stringify(request.args)).digest('hex'),
        });
        return structuredClone(vector.result);
      },
    });
    await chmod(endpoint, 0o600);
    await writeFile(join(profile.stateDir, 'events/control.token'), `${token}\n`, { mode: 0o600 });
    await writeFile(
      join(profile.stateDir, 'events/instance.json'),
      JSON.stringify({
        instanceId: '7'.repeat(32),
        pid: process.pid,
        processStart: `${process.pid}:synthetic`,
        endpoint,
        tokenFingerprint: createHash('sha256').update(token).digest('hex'),
      }),
      { mode: 0o600 },
    );
    return {
      profile,
      journal,
      close: async () => {
        await server.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
