import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PACKAGE_NAME } from '../src/index.ts';

test('package name', () => {
  assert.equal(PACKAGE_NAME, '@cloudpixel/comms-core');
});
