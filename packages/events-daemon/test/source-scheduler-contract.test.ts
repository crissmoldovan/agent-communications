import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoundRobinReadyScopes } from '../src/sources/contracts.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';

test('D3: ready source scopes are round-robin and a pause before recovery prevents a claim', async () => {
  const ready = new RoundRobinReadyScopes();
  ready.replace([
    { source: 'slack', accountId: 'a', scopeId: 'conversation:C001' },
    { source: 'resend', accountId: 'b', scopeId: 'received' },
    { source: 'whatsapp', accountId: 'c', scopeId: 'chat:one' },
  ]);
  assert.deepEqual(
    [ready.next(), ready.next(), ready.next()].map((scope) => scope?.source),
    ['resend', 'slack', 'whatsapp'],
  );

  const lock = new SourceScopeLock();
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = lock.withScope({ source: 'slack', accountId: 'a', scopeId: 'conversation:C001' }, async () => {
    order.push('first');
    await held;
  });
  const second = lock.withScope({ source: 'slack', accountId: 'a', scopeId: 'conversation:C001' }, () =>
    order.push('second'),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);

  const acquired: string[] = [];
  await lock.withScopes(
    [
      { source: 'whatsapp', accountId: 'c', scopeId: 'chat:two' },
      { source: 'resend', accountId: 'b', scopeId: 'status' },
      { source: 'whatsapp', accountId: 'c', scopeId: 'chat:one' },
    ],
    () => acquired.push('ordered'),
  );
  assert.deepEqual(acquired, ['ordered'], 'a replacement may acquire overlapping scopes in one canonical order');
});
