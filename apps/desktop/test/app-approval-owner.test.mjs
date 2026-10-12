import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '../../../packages/core/src/config.ts';
import { EventControlClient } from '../../../packages/events-daemon/src/control/client.ts';
import { startEventOwner } from '../../../packages/events-daemon/src/runtime/owner.ts';
import { openEventDatabase } from '../../../packages/events-daemon/src/store/database.ts';
import { selectEventSecretStore } from '../../../packages/events-daemon/src/store/event-secrets.ts';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { NATIVE_SKIP } from './helpers/native-lane.mjs';

assertLoopbackSeal();

function target() {
  return { targetId: 'target-b3-app-approval', version: 1, kind: 'dry-run', retentionMs: 60_000 };
}

function rule(ruleId) {
  return {
    ruleId,
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: ['ibx_APPAPPROVALTEST1'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { constant: 'synthetic' },
    targets: [target()],
    subscribers: [],
    judges: [],
    deliveryRateCap: 1,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
  };
}

function cargo(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, {
      cwd: new URL('../src-tauri/', import.meta.url),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => (output += chunk));
    }
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, output }));
  });
}

// Compiled Rust approval session under test: ../src-tauri/src/commands/approval.rs
// desktop-mutation: desktop-approval-fresh-view
test('app approval: compiled Rust command views and approves through the sealed real B3 owner', async (t) => {
  if (NATIVE_SKIP) {
    t.skip(NATIVE_SKIP);
    return;
  }
  if (process.platform === 'win32') {
    t.skip('Windows owner control is unavailable');
    return;
  }
  // `/tmp` is deliberately short enough for the real owner socket path on macOS. The desktop's daemon profile accepts
  // only canonical paths, so resolve its link there (`/private/tmp`) before either side sees the root.
  const fsp = await import('node:fs/promises');
  const root = await fsp.realpath(await fsp.mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'd-aa-')));
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const executable = join(root, 'agent-events');
  let owner;
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(configDir, 0o700);
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(executable, 0o700);
    const config = emptyConfig();
    config.inboxes['events/gmail'] = {
      id: 'ibx_APPAPPROVALTEST1',
      provider: 'gmail',
      email: 'desktop-app-approval@example.test',
      identity: 'oidc',
      client: 'desktop-app-approval-client',
      tier: 'read',
      contacts: false,
      grantedScopes: [],
      secretRef: 'gmail:none:ibx_APPAPPROVALTEST1',
      internalDomains: [],
      createdAt: '2026-10-12T00:00:00.000Z',
    };
    await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`, { mode: 0o600 });
    try {
      // The file store, as the daemon's own real-owner proofs use: a Linux runner has no keyring service.
      const selected = await openEventDatabase({ stateDir });
      await selectEventSecretStore(selected.database, 'file');
      selected.close();
      owner = await startEventOwner({
        stateDir,
        configDir,
        tickMs: 60_000,
        newIntentId: (() => {
          let ordinal = 0;
          return () => `act_desktop_app_${++ordinal}`;
        })(),
        // The owner refuses a Gmail source whose stable mailbox id differs from the activation's account.
        gmailSourceFor: async ({ accountId }) => ({
          inboxId: accountId,
          getProfile: async () => ({
            emailAddress: 'desktop-app-approval@example.test',
            messagesTotal: 0,
            threadsTotal: 0,
            historyId: '1',
          }),
        }),
      });
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip('EPERM: sandbox blocks the real owner Unix listener required by this compiled Rust proof');
        return;
      }
      throw error;
    }
    const setup = new EventControlClient({ stateDir, clientName: 'desktop-app-approval-setup' });
    await setup.request('target-add', { document: target() });
    for (const id of ['rule-b3-app-approval-1', 'rule-b3-app-approval-2'])
      await setup.request('rule-create', { document: rule(id) });
    const prepared = await setup.request('rule-enable', { ruleId: 'rule-b3-app-approval-1', version: 1 });
    assert.equal(typeof prepared.approvalId, 'string');
    assert.equal(typeof prepared.binding?.digest, 'string');
    const result = await cargo(
      [
        'test',
        '--offline',
        '--manifest-path',
        'Cargo.toml',
        '--test',
        'app_approval_owner',
        'desktop_app_approval_real_owner',
        '--',
        '--ignored',
        '--exact',
      ],
      {
        ...process.env,
        APP_APPROVAL_EXECUTABLE: executable,
        APP_APPROVAL_STATE_DIR: stateDir,
        APP_APPROVAL_CONFIG_DIR: configDir,
        APP_APPROVAL_ID: prepared.approvalId,
        APP_APPROVAL_DIGEST: prepared.binding.digest,
      },
    );
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /test desktop_app_approval_real_owner \.\.\. ok/u);
  } finally {
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
