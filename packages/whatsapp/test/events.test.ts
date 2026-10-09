import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withCurrentEventVisibility, withEventSnapshot } from '../src/operations/events.ts';
import { readRawEventMessages } from '../src/source/event-reader.ts';
import { inspectSchema } from '../src/source/schema.ts';
import { openDatabase } from '../src/sqlite.ts';
import { ALICE, BOB, buildFixtureStore } from './support/fixture.ts';
import { newHarness, tempDir } from './support/harness.ts';

test('D6: the event reader retains the raw sender and tri-state fromMe instead of index identities', async () => {
  const fixture = await buildFixtureStore(join(tempDir('whatsapp-events-'), 'store'));
  try {
    const database = await openDatabase(fixture.path, { readOnly: true });
    try {
      const rows = readRawEventMessages(database, inspectSchema(database));
      const received = rows.find((row) => row.stanzaId === '3EB0TEST00000001');
      const sent = rows.find((row) => row.stanzaId === '3EB0TEST00000002');
      assert.deepEqual(
        received && {
          chatJid: received.chatJid,
          senderJidRaw: received.senderJidRaw,
          fromMe: received.fromMe,
        },
        {
          chatJid: '15555550101@s.whatsapp.net',
          senderJidRaw: '15555550101@s.whatsapp.net',
          fromMe: false,
        },
      );
      assert.equal(sent?.fromMe, true);
    } finally {
      database.close();
    }
  } finally {
    await fixture.close();
  }
});

test('P1: the event reader retains raw WhatsApp identity bytes, including surrounding and all-whitespace fields', async () => {
  const fixture = await buildFixtureStore(join(tempDir('whatsapp-events-raw-identity-'), 'store'), { wal: true });
  try {
    const before = await openDatabase(fixture.path, { readOnly: true });
    let sourceOrder: number;
    try {
      const row = readRawEventMessages(before, inspectSchema(before)).find(
        (message) => message.stanzaId === '3EB0TEST00000001',
      );
      if (row === undefined) throw new Error('the fixture must contain the raw identity row');
      sourceOrder = row.sourceOrder;
    } finally {
      before.close();
    }
    fixture.write(
      `UPDATE ZWACHATSESSION SET ZCONTACTJID = ' 15555550101@s.whatsapp.net '
        WHERE ZCONTACTJID = '15555550101@s.whatsapp.net';
       UPDATE ZWAMESSAGE
          SET ZFROMJID = ' 15555550101@s.whatsapp.net ', ZSTANZAID = ' '
        WHERE Z_PK = ${sourceOrder}`,
    );
    const database = await openDatabase(fixture.path, { readOnly: true });
    try {
      const row = readRawEventMessages(database, inspectSchema(database)).find(
        (message) => message.sourceOrder === sourceOrder,
      );
      assert.deepEqual(row && [row.chatJid, row.senderJidRaw, row.stanzaId], [
        ' 15555550101@s.whatsapp.net ',
        ' 15555550101@s.whatsapp.net ',
        ' ',
      ]);
    } finally {
      database.close();
    }
  } finally {
    await fixture.close();
  }
});

test('D6: a malformed raw fromMe value remains unknown instead of becoming an eligible false', async () => {
  const fixture = await buildFixtureStore(join(tempDir('whatsapp-events-null-'), 'store'), { wal: true });
  try {
    fixture.write("UPDATE ZWAMESSAGE SET ZISFROMME = NULL WHERE ZSTANZAID = '3EB0TEST00000001'");
    const database = await openDatabase(fixture.path, { readOnly: true });
    try {
      const rows = readRawEventMessages(database, inspectSchema(database));
      assert.equal(rows.find((row) => row.stanzaId === '3EB0TEST00000001')?.fromMe, null);
    } finally {
      database.close();
    }
  } finally {
    await fixture.close();
  }
});

test('D6: an event snapshot rebuilds the checked-copy lifecycle before passing raw rows to its callback', async () => {
  const harness = await newHarness();
  try {
    await harness.ready();
    const accountId = String(harness.coreConfig().accounts['acme/whatsapp']?.id);
    const stanzaIds = await withEventSnapshot(harness.context(), { accountId }, async (current) => {
      assert.equal(current.accountName, 'acme/whatsapp');
      assert.ok(current.messages.some((message) => message.fromMe === false));
      return current.messages.map((message) => message.stanzaId);
    });
    assert.ok(stanzaIds.includes('3EB0TEST00000001'));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test('D6: the event visibility operation reads the list file afresh and supplies a lowercase canonical digest', async () => {
  const harness = await newHarness();
  try {
    await harness.ready();
    const context = harness.context();
    const accountId = String(harness.coreConfig().accounts['acme/whatsapp']?.id);
    const before = await withCurrentEventVisibility(context, { accountId }, (visibility) => ({
      digest: visibility.digest,
      seesBob: visibility.seesMessage(BOB, 'direct', BOB, false),
    }));
    await context.lists.update(accountId, () => ({ allow: [ALICE], deny: [] }));
    const after = await withCurrentEventVisibility(context, { accountId }, (visibility) => ({
      digest: visibility.digest,
      seesAlice: visibility.seesMessage(ALICE, 'direct', ALICE, false),
      seesBob: visibility.seesMessage(BOB, 'direct', BOB, false),
    }));
    assert.match(before.digest, /^[0-9a-f]{64}$/u);
    assert.notEqual(after.digest, before.digest);
    assert.equal(before.seesBob, true);
    assert.equal(after.seesAlice, true);
    assert.equal(after.seesBob, false);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test('D6: resetting every channel-owned index artifact rebuilds from raw rows without changing event-source facts', async () => {
  const harness = await newHarness();
  try {
    await harness.ready();
    const context = harness.context();
    const accountId = String(harness.coreConfig().accounts['acme/whatsapp']?.id);
    const ids = async () =>
      withEventSnapshot(context, { accountId }, (snapshot) =>
        snapshot.messages.map((message) => [message.chatJid, message.senderJidRaw, message.stanzaId, message.fromMe]),
      );
    const before = await ids();
    await harness.resetAndRebuildAllIndexState();
    assert.deepEqual(await ids(), before);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});
