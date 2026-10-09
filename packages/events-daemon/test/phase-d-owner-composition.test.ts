import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '@agentcomms/core';
import { openWhatsAppEventOperations } from '@agentcomms/whatsapp';
import { startEventOwner } from '../src/runtime/owner.ts';
import {
  createPhaseDWhatsAppOwnerComposition,
  requirePhaseDWhatsAppVisibilitySeam,
} from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { PassThroughSseFrameVisibilityGate } from '../src/runtime/phase-d-whatsapp-seam.ts';
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

test('D7: a production owner with the WhatsApp source and no concrete fence refuses to start and never uses the pass-through gate', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-d7-seam-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(emptyConfig())}\n`);
  const prototype = PassThroughSseFrameVisibilityGate.prototype;
  const original = prototype.withCurrentSseFrameVisibility;
  let passThroughCalls = 0;
  prototype.withCurrentSseFrameVisibility = async function (
    this: PassThroughSseFrameVisibilityGate,
    ...args: Parameters<typeof original>
  ) {
    passThroughCalls += 1;
    return original.apply(this, args);
  } as typeof original;
  try {
    await assert.rejects(
      startEventOwner({
        stateDir,
        configDir,
        tickMs: 60_000,
        phaseDComposition: (input) => ({
          ...createPhaseDWhatsAppOwnerComposition(input),
          visibilityFence: undefined as never,
        }),
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
    );
    assert.equal(passThroughCalls, 0, "the refused owner never selected B2's pre-D pass-through gate");
    // The refused start left nothing held: a normal owner starts on the same state directory and stops cleanly.
    const owner = await startEventOwner({ stateDir, configDir, tickMs: 60_000 });
    await owner.stop();
  } finally {
    prototype.withCurrentSseFrameVisibility = original;
    await rm(root, { recursive: true, force: true });
  }
});
