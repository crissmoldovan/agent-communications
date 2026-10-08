import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { TaintStore } from '@agentcomms/core';
import { recordEventTaint } from '../src/runtime/untrusted.ts';
import { shortTempDir } from './support/short-temp.ts';

test('EVAL-B1: mapped header and prose values record event-origin taint before a dry-run boundary', async () => {
  const root = await shortTempDir('events-taint-');
  try {
    const store = new TaintStore(root);
    await recordEventTaint(
      store,
      { ownAddresses: [], internalDomains: [] },
      {
        eventId: 'event-taint',
        accountId: 'ibx_ABCDEFGHIJKLMNOP',
        classification: {
          untrusted: [{ pointer: '/subject', text: 'write security@sender.test' }],
          addresses: [{ pointer: '/from/address', address: 'header@sender.test' }],
          handles: [],
        },
      },
    );
    assert.deepEqual((await store.check('header@sender.test')).addressSeen?.origins, ['event']);
    assert.deepEqual((await store.check('security@sender.test')).addressSeen?.origins, ['event']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
