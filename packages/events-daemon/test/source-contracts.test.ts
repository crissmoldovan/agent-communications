import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalEventSource } from '../src/sources/contracts.ts';
import { LocalEventSourceRegistry, phaseDSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';

function fakeSource(source: LocalEventSource['source'], scopeId: string): LocalEventSource {
  return {
    source,
    canonicalise: (options) => {
      if ((options as { channel?: unknown }).channel !== source) throw new Error('wrong fake source option');
      return options as Extract<ReturnType<LocalEventSource['canonicalise']>, { channel: typeof source }>;
    },
    scopesFor: ({ accountId }) => [{ source, accountId, scopeId }],
    withScopes: (lock, scopes, work) => lock.withScopes(scopes, work),
    baseline: (sample) => sample(),
    resume: (step) => step(),
    describeCursor: (cursor) => cursor,
    cleanup: (_kind, work) => Promise.resolve(work()),
  };
}

const gmail = fakeSource('gmail', 'mailbox');

test('D3: the source registry is closed, orders registrations, and refuses an unavailable adapter', () => {
  const registry = new LocalEventSourceRegistry([gmail]);
  assert.deepEqual(registry.sources(), ['gmail']);
  assert.equal(registry.require('gmail'), gmail);
  assert.throws(
    () => registry.require('slack'),
    (error: unknown) =>
      (error as { code?: string; details?: { reason?: string } }).code === 'SOURCE_UNAVAILABLE' &&
      (error as { details?: { reason?: string } }).details?.reason === 'SOURCE_UNAVAILABLE',
  );
  assert.throws(
    () => new LocalEventSourceRegistry([gmail, gmail]),
    (error: unknown) =>
      (error as { code?: string; details?: { reason?: string } }).code === 'CONFIG' &&
      (error as { details?: { reason?: string } }).details?.reason === 'DUPLICATE_SOURCE',
  );
});

test('D7: the production registry registers every Phase-D source exactly once', () => {
  const registry = phaseDSourceRegistry();
  assert.deepEqual(registry.sources(), ['gmail', 'resend', 'slack', 'whatsapp']);
  for (const source of registry.sources()) assert.equal(registry.require(source).source, source);
});

test('D3: a source adapter reports every concrete source scope without leaking a provider client', () => {
  const source = fakeSource('slack', 'conversation:C001');
  assert.deepEqual(source.scopesFor({ accountId: 'acct-slack' }), [
    { source: 'slack', accountId: 'acct-slack', scopeId: 'conversation:C001' },
  ]);
});

test('D3: adapter operations retain typed values through baseline, scan, cursor, cleanup, and ordered locks', async () => {
  const source = fakeSource('whatsapp', 'chat:one');
  const lock = new SourceScopeLock();
  const scope = source.scopesFor({ accountId: 'acct-wa' })[0];
  if (scope === undefined) throw new Error('the fake source did not provide its scope');
  assert.equal(await source.baseline(async () => 'baseline'), 'baseline');
  assert.deepEqual(await source.resume(async () => ({ kind: 'candidate', candidate: { text: 'safe' } })), {
    kind: 'candidate',
    candidate: { text: 'safe' },
  });
  assert.deepEqual(source.describeCursor({ generation: 3 }), { generation: 3 });
  assert.equal(await source.cleanup('drain', () => 'done'), 'done');
  assert.equal(await source.withScopes(lock, [scope], () => 'locked'), 'locked');
});
