import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, EXIT_CODES, toCommsError } from '../src/errors.ts';
import { errorEnvelope, okEnvelope, SCHEMA_VERSION } from '../src/output.ts';

test('every error code maps to its documented exit code', () => {
  assert.equal(new CommsError('APPROVAL_REQUIRED', 'x').exitCode, 10);
  assert.equal(new CommsError('USAGE', 'x').exitCode, 64);
  assert.equal(new CommsError('BAD_DATA', 'x').exitCode, 65);
  assert.equal(new CommsError('NOT_FOUND', 'x').exitCode, 66);
  assert.equal(new CommsError('PROVIDER_UNAVAILABLE', 'x').exitCode, 69);
  assert.equal(new CommsError('TRANSIENT', 'x').exitCode, 75);
  assert.equal(new CommsError('AUTH_REQUIRED', 'x').exitCode, 77);
  assert.equal(new CommsError('CONFIG', 'x').exitCode, 78);
  assert.equal(new CommsError('UNEXPECTED', 'x').exitCode, 1);
  assert.equal(EXIT_CODES.OK, 0);
});

test('toCommsError keeps a CommsError and wraps anything else as UNEXPECTED', () => {
  const original = new CommsError('NOT_FOUND', 'gone');
  assert.equal(toCommsError(original), original);
  const wrapped = toCommsError(new TypeError('boom'));
  assert.equal(wrapped.code, 'UNEXPECTED');
  assert.equal(wrapped.message, 'boom');
  assert.equal(toCommsError('text').message, 'text');
});

test('envelopes carry the schema version and omit absent optional fields', () => {
  assert.deepEqual(okEnvelope({ a: 1 }), { ok: true, schemaVersion: SCHEMA_VERSION, data: { a: 1 } });
  assert.deepEqual(errorEnvelope(new CommsError('CONFIG', 'bad')), {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    error: { code: 'CONFIG', message: 'bad' },
  });
  assert.deepEqual(errorEnvelope(new CommsError('AUTH_REQUIRED', 'reauth', { hint: 'run x' })).error, {
    code: 'AUTH_REQUIRED',
    message: 'reauth',
    hint: 'run x',
  });
});
