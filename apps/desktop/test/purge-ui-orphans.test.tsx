import assert from 'node:assert/strict';
import { test } from 'node:test';

// desktop-mutation: desktop-superseded-destructive-invalidation
test('purge-ui: superseded destructive success invalidates cached and painted state', async () => {
  const { ControlModel } = await import('../src/control-model.ts');
  const { createScreenController } = await import('../src/screen-controller.ts');
  const pending = [];
  const model = new ControlModel(
    async (_command, input) => new Promise((resolve, reject) => pending.push({ input, resolve, reject })),
  );
  const painted = [];
  const errors = [];
  const controller = createScreenController(
    model,
    (rows) => painted.push(rows),
    (error) => {
      if (error) errors.push(error);
    },
  );
  const reply = (index, text) => ({
    result: {
      operation: pending[index].input.input.request.operation,
      segments: [{ path: '/0', text, trust: 'untrusted' }],
      code: null,
      truncated: false,
      approval: null,
    },
    association: pending[index].input.input.selection,
    generation: 1,
  });
  const cached = controller.run('rules-list', {});
  pending[0].resolve(reply(0, 'A enabled'));
  await cached;
  assert.equal(painted.at(-1)['rules-list'].segments[0].text, 'A enabled');
  const disableA = controller.run('rule-disable', { ruleId: 'A' });
  const disableB = controller.run('rule-disable', { ruleId: 'B' });
  const lateRead = controller.run('source-show', { source: 'source-1' });
  pending[1].resolve(reply(1, 'A disabled'));
  await disableA;
  pending[2].reject(new Error('B failed'));
  await disableB;
  assert.equal(
    model.rows.has('rules-list'),
    false,
    'A success invalidates the cached enabled row even when superseded',
  );
  assert.equal('rules-list' in painted.at(-1), false, 'A success also clears the painted row');
  assert.equal('rule-disable' in painted.at(-1), false, 'superseded A is not published');
  pending[3].resolve(reply(3, 'stale source'));
  await lateRead;
  assert.equal(model.rows.has('source-show'), false, 'in-flight reads cannot restore invalidated state');
  assert.equal('source-show' in painted.at(-1), false);
  assert.deepEqual(errors, [], 'errors superseded by invalidation remain suppressed');
});

// desktop-mutation: desktop-purge-ui-orphans
test('purge-ui: desktop-purge-ui-orphans cancels late results after destructive replies and reconnect', async () => {
  const { ControlModel } = await import('../src/control-model.ts');
  for (const operation of [
    'rule-disable',
    'rule-remove',
    'target-remove',
    'dropDelivery',
    'decideHeld',
    'dryrun-show',
    'disable-all',
  ]) {
    let resolveLate: (value: unknown) => void = () => {};
    const late = new Promise((resolve) => {
      resolveLate = resolve;
    });
    const model = new ControlModel(async (_command, args) =>
      args.input.request.operation === 'rules-list'
        ? late
        : {
            result: { operation, segments: [], code: null, truncated: false, approval: null },
            association: args.input.selection,
            generation: 1,
          },
    );
    const pending = model.control('rules-list', {});
    await model.control(operation, { ruleId: 'rule-1', targetId: 'target-1', deliveryId: 'delivery-1' });
    resolveLate({
      result: { operation: 'rules-list', segments: [{ text: 'stale reveal', trust: 'untrusted', path: '' }] },
      association: null,
      generation: 1,
    });
    await pending;
    assert.equal(model.rows.has('rules-list'), false, operation);
    model.reconnect();
    assert.equal(model.rows.size, 0);
  }
});
