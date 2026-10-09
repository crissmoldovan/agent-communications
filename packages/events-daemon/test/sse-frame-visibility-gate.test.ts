import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D6: every sealed WhatsApp frame is refused when its tuple is hidden', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('events-whatsapp-frame-');
  const store = await openEventDatabase({ stateDir });
  try {
    const fence = new WhatsAppVisibilityFence({
      store,
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 1, digest: 'c'.repeat(64), seesMessage: () => false }),
    });
    let writes = 0;
    const result = await fence.withCurrentSseFrameVisibility(
      { accountId: 'wa_frame', whatsappMessageId: '["wa-msg","chat@example.test","sender@example.test","one"]' },
      () => {
        writes += 1;
        return 'written';
      },
    );
    assert.equal(result, undefined);
    assert.equal(writes, 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
