import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openWhatsAppEventOperations } from '@agentcomms/whatsapp';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { createPhaseDWhatsAppOwnerComposition } from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { phaseDSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D7: a removed non-Gmail source scope is purged before the scheduler can select it again', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d7-source-fence-');
  const configDir = join(stateDir, 'config');
  await mkdir(configDir, { recursive: true });
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '0', 0)",
      )
      .run('acc_removed_slack', 'slack:acc_removed_slack:C001');
    const composition = createPhaseDWhatsAppOwnerComposition({
      database: store,
      eventOperations: openWhatsAppEventOperations({ configDir }),
    });
    const scheduler = new EventScheduler({
      store,
      lifecycle: new EventLifecycle(store),
      activations: { resumeClaimedCompletions: async () => undefined } as never,
      dispatcher: {} as never,
      expiry: { sweepAll: async () => undefined } as never,
      cipher: {} as never,
      approvals: {} as never,
      config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
      taint: {} as never,
      gmailSourceFor: async () => {
        throw new Error('a removed Slack scope must not poll Gmail');
      },
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      sourceRegistry: phaseDSourceRegistry(),
      whatsappVisibilityFence: composition.visibilityFence,
    });
    await scheduler.tick();
    assert.equal(
      store.database.prepare("SELECT 1 FROM cursors WHERE source = 'slack' AND account_id = 'acc_removed_slack'").get(),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D7b/W: the one scheduler owner refuses a WhatsApp source unless it holds the concrete visibility fence', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d7-whatsapp-seam-');
  const store = await openEventDatabase({ stateDir });
  try {
    assert.throws(
      () =>
        new EventScheduler({
          store,
          lifecycle: new EventLifecycle(store),
          activations: { resumeClaimedCompletions: async () => undefined } as never,
          dispatcher: {} as never,
          expiry: { sweepAll: async () => undefined } as never,
          cipher: {} as never,
          approvals: {} as never,
          config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
          taint: {} as never,
          gmailSourceFor: async () => {
            throw new Error('not Gmail');
          },
          mailboxLock: new MailboxLock(new SourceScopeLock()),
          sourceRegistry: phaseDSourceRegistry(),
        }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
