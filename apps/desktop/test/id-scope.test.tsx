import assert from 'node:assert/strict';
import { test } from 'node:test';

// desktop-mutation: desktop-id-scope
test('id-scope: desktop-id-scope rejects same-looking cross-account and stale-version replies', async () => {
  const { ControlModel } = await import('../src/control-model.ts');
  const selection = { deliveryId: 'delivery-1', targetVersion: 1, accountId: 'account-1' };
  const result = { operation: 'dryrun-show', segments: [], code: null, truncated: false, approval: null };
  const calls: unknown[] = [];
  const model = new ControlModel(async (_command, input) => {
    calls.push(input);
    return { result, association: { ...selection, accountId: 'account-2' }, generation: 1 };
  });
  await assert.rejects(model.control('dryrun-show', { deliveryId: 'delivery-1' }, selection), /SCOPE_MISMATCH/);
  assert.equal(model.rows.size, 0);
  assert.equal(calls[0].input.selection.deliveryId, 'delivery-1');
  for (const changed of [{ deliveryId: 'alias' }, { targetVersion: 2 }]) {
    const other = new ControlModel(async () => ({ result, association: { ...selection, ...changed }, generation: 1 }));
    await assert.rejects(other.control('dryrun-show', { deliveryId: 'delivery-1' }, selection), /SCOPE_MISMATCH/);
  }
});

// Compiled Rust guard under test: ../src-tauri/src/commands/control.rs
// desktop-mutation: desktop-nested-document-scope
test('id-scope: rule update carries nested document identity and refuses a cross-rule reply before paint', async () => {
  const { ControlModel } = await import('../src/control-model.ts');
  const document = {
    ruleId: 'rule-1',
    version: 1,
    source: { channel: 'gmail', accountIds: ['account-1'] },
  };
  const result = { operation: 'rule-update', segments: [], code: null, truncated: false, approval: null };
  const calls: unknown[] = [];
  const model = new ControlModel(async (_command, input) => {
    calls.push(input);
    return {
      result,
      association: {
        objectId: 'rule-2',
        version: 2,
        'document.ruleId': 'rule-2',
        'document.version': 2,
        'document.source.channel': 'gmail',
        'document.source.accountIds': ['account-1'],
      },
      generation: 1,
    };
  });
  await assert.rejects(model.control('rule-update', { document }), /SCOPE_MISMATCH/);
  assert.equal(model.rows.size, 0);
  assert.deepEqual(calls[0].input.selection, {
    objectId: 'rule-1',
    version: 1,
    'document.ruleId': 'rule-1',
    'document.version': 1,
    'document.source.channel': 'gmail',
    'document.source.accountIds': ['account-1'],
  });
});
