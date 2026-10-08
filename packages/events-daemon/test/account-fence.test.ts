import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLiveGmailAccount } from '../src/runtime/account-fence.ts';

test('TGT-B1: the account fence loads core configuration at each boundary and never retains an account identity', async () => {
  let present = true;
  let loads = 0;
  const config = {
    load: async () => {
      loads += 1;
      return { inboxes: present ? { events: { id: 'account-1', provider: 'gmail' } } : {} };
    },
  };
  await assertLiveGmailAccount(config as never, 'account-1');
  present = false;
  await assert.rejects(
    () => assertLiveGmailAccount(config as never, 'account-1'),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
  );
  assert.equal(loads, 2, 'each boundary reads current configuration rather than a daemon identity cache');
});
