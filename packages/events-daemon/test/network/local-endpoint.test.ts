import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { LocalEndpointError, validateLocalEndpoint } from '../../src/network/local-endpoint.ts';

test('NET-B2: a local endpoint is HTTP and one approved literal loopback host only', () => {
  const endpoint = validateLocalEndpoint('http://127.0.0.1:11434/v1', ['127.0.0.1']);
  assert.equal(endpoint.address, '127.0.0.1');
  for (const url of ['https://127.0.0.1:11434/', 'http://localhost:11434/', 'http://10.0.0.1:11434/']) {
    assert.throws(() => validateLocalEndpoint(url, ['127.0.0.1']), LocalEndpointError);
  }
  for (const approvedAddressSet of [['127.0.0.1', '::1'], ['127.0.0.0/8']]) {
    assert.throws(() => validateLocalEndpoint('http://127.0.0.1:11434/v1', approvedAddressSet), LocalEndpointError);
  }
});

test('NET-B2: local-endpoint validation has no operation, dispatcher, or judge call edge', async () => {
  const source = await readFile(new URL('../../src/network/local-endpoint.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:operations|dispatcher|judge|scheduler)/i);
});
