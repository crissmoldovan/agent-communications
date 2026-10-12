import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../../../packages/core/src/config.ts';
import { startEventOwner } from '../../../packages/events-daemon/src/runtime/owner.ts';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

function diagnostics(output) {
  const panic = output.split(/\r?\n/u).find((line) => line.includes('panicked at'));
  const code = output.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/u)?.[0] ?? 'NO_STABLE_ERROR_CODE';
  const safePanic = (panic ?? 'no panic text').replaceAll(/synthetic-[^\s]+/gu, '[sensitive panic text redacted]');
  return `panic: ${safePanic}; code: ${code}`;
}

// Compiled wire boundary: ../src-tauri/src/control/client.rs
// desktop-mutation: desktop-secret-control-trace
test('secret-trace: compiled native commands carry hidden bytes only through the sealed real owner secret path', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows owner control is unavailable');
    return;
  }
  const root = await realpath(await mkdtemp('/tmp/d-st-'));
  const statePath = join(root, 'state');
  const configPath = join(root, 'config');
  const executablePath = join(root, 'agent-events');
  let owner;
  try {
    await chmod(root, 0o700);
    await mkdir(statePath, { mode: 0o700 });
    await mkdir(configPath, { mode: 0o700 });
    await writeFile(executablePath, '', { mode: 0o700 });
    const [stateDir, configDir, executable] = await Promise.all([
      realpath(statePath),
      realpath(configPath),
      realpath(executablePath),
    ]);
    const accountId = 'ibx_SECRETTRACE00001';
    const config = emptyConfig();
    config.inboxes['secret-trace/gmail'] = {
      id: accountId,
      provider: 'gmail',
      email: 'secret-trace@example.test',
      identity: 'oidc',
      client: 'secret-trace-client',
      tier: 'read',
      contacts: false,
      grantedScopes: [],
      secretRef: `gmail:none:${accountId}`,
      internalDomains: [],
      createdAt: '2026-10-12T00:00:00.000Z',
    };
    await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`, { mode: 0o600 });
    // Probe the production listener before spawning the native harness, so an OS refusal is identified precisely.
    try {
      owner = await startEventOwner({
        stateDir,
        configDir,
        tickMs: 60_000,
        // The owner must not open Gmail in this sealed fixture. Its stable inbox id is nevertheless checked at the
        // production boundary whenever a source is required.
        gmailSourceFor: async ({ accountId: requestedAccountId }) => ({
          inboxId: requestedAccountId,
          getProfile: async () => ({
            emailAddress: 'secret-trace@example.test',
            messagesTotal: 0,
            threadsTotal: 0,
            historyId: '1',
          }),
        }),
      });
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('EPERM: sandbox denies the production owner Unix listener');
        return;
      }
      throw error;
    }
    await owner.stop();
    owner = undefined;
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const seal = fileURLToPath(new URL('../../../test/helpers/loopback-seal-preload.mjs', import.meta.url));
    const script = fileURLToPath(new URL('./helpers/secret-owner.mjs', import.meta.url));
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(seal)} --experimental-strip-types --disable-warning=ExperimentalWarning ${quote(script)} "$@"\n`,
      { mode: 0o700 },
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        'cargo',
        [
          'test',
          '--offline',
          '--manifest-path',
          'apps/desktop/src-tauri/Cargo.toml',
          '--test',
          'secret_boundary',
          'native_commands_over_spawned_owner',
          '--',
          '--ignored',
          '--exact',
        ],
        {
          cwd: new URL('../../../', import.meta.url),
          env: { ...process.env, SECRET_TRACE_ROOT: root },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (data) => {
          output += String(data);
        });
      child.on('error', reject);
      child.on('exit', (status) => resolve({ status, output }));
    });
    assert.equal(result.status, 0, `compiled secret owner harness failed; ${diagnostics(result.output)}`);
    assert.match(result.output, /test native_commands_over_spawned_owner \.\.\. ok/u);
    assert.equal(result.output.includes('synthetic-hidden'), false, 'secret sentinel reached a test log');
  } finally {
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
