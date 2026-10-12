import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { installErrorSink } from '../../src/network/error-sink.ts';

test('NET-B2: a permanent error sink remains after an operation listener settles', () => {
  const resource = new EventEmitter();
  const temporary = () => undefined;
  resource.once('error', temporary);
  installErrorSink(resource);
  resource.off('error', temporary);

  assert.equal(resource.listenerCount('error'), 1, 'the permanent sink outlives the operation listener');
  assert.doesNotThrow(() => resource.emit('error', new Error('synthetic transport reset')));
});
