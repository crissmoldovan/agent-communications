import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { ControlModel } from '../src/control-model.ts';
import { OperationForm } from '../src/screens/shared';
import { Sources } from '../src/screens/sources';

function findOperation(node, operation) {
  if (!React.isValidElement(node)) return undefined;
  if (node.type === OperationForm && node.props.operation === operation) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findOperation(child, operation);
    if (found) return found;
  }
}

// desktop-mutation: desktop-screen-current-request
test('screen-request: the production screen route rejects out-of-order selection replies', async () => {
  const { createScreenController } = await import('../src/screen-controller');
  const { OperationFormView } = await import('../src/screens/shared');
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
  const screen = Sources({ results: {}, onOperation: controller.run, onApproval() {}, onSecrets() {} });
  const element = findOperation(screen, 'source-show');
  assert.ok(element);
  const submit = (source) =>
    OperationFormView({
      ...element.props,
      document: JSON.stringify({ source }),
      expectedScope: '{}',
      error: '',
      onDocument() {},
      onScope() {},
      onError() {},
    }).props.onSubmit({ preventDefault() {} });
  const a = submit('source-A');
  const b = submit('source-B');
  assert.deepEqual(
    pending.map(({ input }) => input.input.selection),
    [{ source: 'source-A' }, { source: 'source-B' }],
  );
  const reply = (source) => ({
    result: {
      operation: 'source-show',
      segments: [{ path: '/source', text: source, trust: 'untrusted' }],
      code: null,
      truncated: false,
      approval: null,
    },
    association: { source },
    generation: 1,
  });
  pending[1].resolve(reply('source-B'));
  await b;
  pending[0].resolve(reply('source-A'));
  await a;
  assert.equal(model.rows.get('source-show').segments[0].text, 'source-B');
  assert.equal(painted.at(-1)['source-show'].segments[0].text, 'source-B');
  assert.equal(errors.length, 0);
  const c = submit('source-C');
  const d = submit('source-D');
  pending[3].resolve(reply('source-D'));
  await d;
  pending[2].reject(new Error('stale error'));
  await c;
  assert.equal(errors.length, 0);
  const approvalA = controller.approval('approval-A', 'digest-A', null);
  const approvalB = controller.approval('approval-B', 'digest-B', null);
  const approvalReply = (id) => ({
    operation: 'approvalView',
    segments: [],
    code: 'APP_APPROVAL_UNAVAILABLE',
    truncated: false,
    approval: { approvalId: `approval-${id}`, digest: `digest-${id}`, challenge: `challenge-${id}`, expiresAt: 9000 },
  });
  pending[5].resolve(approvalReply('B'));
  await approvalB;
  pending[4].resolve(approvalReply('A'));
  await approvalA;
  assert.equal(painted.at(-1).approvalView.approval.approvalId, 'approval-B');
});
