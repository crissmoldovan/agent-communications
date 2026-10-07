import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { MIN_NODE, nodeSupportsSqlite, requireSupportedNode } from '../src/runtime/sqlite.ts';

test('PKG-B1-b: the event service runs from the Node where its SQLite is complete, and refuses an older one by name', () => {
  assert.equal(MIN_NODE, '22.16.0');
  for (const version of ['22.12.0', 'v22.13.1', '22.15.1', '20.19.0']) assert.equal(nodeSupportsSqlite(version), false);
  for (const version of ['22.16.0', 'v22.18.0', '22.22.3', '24.0.0', '25.1.0-pre']) {
    assert.equal(nodeSupportsSqlite(version), true);
  }
  assert.doesNotThrow(() => requireSupportedNode('22.16.0'));
  assert.throws(
    () => requireSupportedNode('22.12.0'),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'CONFIG');
      assert.equal(error.exitCode, 78);
      assert.match(error.message, /needs Node 22\.16\.0 or newer, and this is Node 22\.12\.0/);
      assert.match(error.hint ?? '', /Install a newer Node/);
      assert.deepEqual(error.details, { reason: 'NODE_TOO_OLD', node: '22.12.0', needs: '22.16.0' });
      return true;
    },
  );
});
