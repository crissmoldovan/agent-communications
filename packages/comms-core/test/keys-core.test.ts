import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openCore } from '../src/core.ts';
import { APPROVAL_KEY_REF, getOrCreateApprovalKey } from '../src/keys.ts';
import { FileSecretStore } from '../src/secrets.ts';
import { tempDir } from './helpers/temp.ts';

test('the approval key is 32 bytes, created once and then reused', async () => {
  const store = new FileSecretStore(join(tempDir(), 'secrets'));
  const first = await getOrCreateApprovalKey(store);
  assert.equal(first.length, 32);
  assert.deepEqual(await getOrCreateApprovalKey(store), first);
  await store.set(APPROVAL_KEY_REF, Buffer.from('short').toString('base64'));
  assert.equal((await getOrCreateApprovalKey(store)).length, 32, 'a damaged key is replaced');
});

test('openCore wires every store under one config directory and opens the recorded secret backend', async () => {
  const config = tempDir();
  const core = openCore({ env: { AGENT_COMMS_CONFIG_DIR: config } });
  assert.equal(core.paths.configDir, config);
  assert.equal(core.approvals.directory, join(config, 'state', 'approvals'));
  assert.equal(core.ledger.directory, join(config, 'state', 'sends'));
  assert.equal(core.taint.directory, join(config, 'state', 'taint'));
  await core.config.update((c) => ({ ...c, secrets: { store: 'file' } }));
  const secrets = await core.secrets();
  assert.equal(secrets.kind, 'file');
  assert.equal(await core.secrets(), secrets, 'the backend is opened once');
});
