import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openWhatsAppEventOperations } from '@agentcomms/whatsapp';
import {
  createPhaseDWhatsAppOwnerComposition,
  requirePhaseDWhatsAppVisibilitySeam,
} from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D11: the D owner composition always creates a concrete visibility fence before B2 exists', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-d-owner-composition-');
  const configDir = join(stateDir, 'config');
  await mkdir(configDir, { recursive: true });
  const database = await openEventDatabase({ stateDir });
  try {
    const composition = createPhaseDWhatsAppOwnerComposition({
      database,
      eventOperations: openWhatsAppEventOperations({ configDir }),
    });
    let writes = 0;
    const visible = await composition.visibilityFence.withCurrentSseFrameVisibility(
      { accountId: 'wa_composition', whatsappMessageId: '["wa-msg","chat@example.test","sender@example.test","one"]' },
      () => {
        writes += 1;
      },
    );
    assert.equal(visible, undefined);
    assert.equal(writes, 1, 'an empty list is unrestricted, but the concrete D fence still mediated the write');
    assert.ok(composition.retainedContentHooks, 'D hooks remain available before B2 has a participant');
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D11: a supplied retained-content constructor registers each participant exactly once', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-d-owner-composition-');
  const configDir = join(stateDir, 'config');
  await mkdir(configDir, { recursive: true });
  const database = await openEventDatabase({ stateDir });
  try {
    let constructors = 0;
    const composition = createPhaseDWhatsAppOwnerComposition({
      database,
      eventOperations: openWhatsAppEventOperations({ configDir }),
      createRetainedContentParticipants: () => {
        constructors += 1;
        return {
          list: { purgeNewlyHiddenInTransaction: () => undefined },
          retention: { shortenOrPurgeInTransaction: () => undefined },
        };
      },
    });
    assert.equal(constructors, 1);
    assert.throws(
      () =>
        composition.retainedContentHooks.registerWhatsAppListChangeParticipant({
          purgeNewlyHiddenInTransaction: () => undefined,
        }),
      /already registered/u,
    );
    assert.throws(
      () =>
        composition.retainedContentHooks.registerRetentionTighteningParticipant({
          shortenOrPurgeInTransaction: () => undefined,
        }),
      /already registered/u,
    );
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D7: a registered WhatsApp source refuses to start without its concrete visibility seam', () => {
  assert.throws(
    () => requirePhaseDWhatsAppVisibilitySeam({ hasWhatsAppSource: true, visibilityFence: undefined }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
  );
  assert.equal(
    requirePhaseDWhatsAppVisibilitySeam({ hasWhatsAppSource: false, visibilityFence: undefined }),
    undefined,
    'the no-D-source control path alone may omit the D visibility fence',
  );
});
