import assert from 'node:assert/strict';
import { DURABLE_CUTOVER_EDGES, type DurableCutoverEdge } from '../../src/runtime/cutover-failpoint.ts';
import { PhaseDCutoverFixture, type WhatsAppCutoverMessage } from './phase-d-cutover.ts';

export type WhatsAppCutoverAttempt = Readonly<{
  /** The one concurrent production scan which is crashed/restarted at this durable edge. */
  readonly sourceAtDurableEdge: (scopeId?: string) => Promise<void>;
  /** A normal production source turn used to prepare the named transition. */
  readonly sourceTurn: (scopeId?: string) => Promise<void>;
  readonly edge: DurableCutoverEdge | undefined;
}>;

export function whatsappMessage(
  stanzaId: string,
  chatJid = 'chat-cutover',
  senderJidRaw = 'sender-cutover',
): WhatsAppCutoverMessage {
  return { chatJid, senderJidRaw, stanzaId, body: `synthetic:${stanzaId}` };
}

export function whatsappRawKey(message: WhatsAppCutoverMessage): string {
  return JSON.stringify(['wa-msg', message.chatJid, message.senderJidRaw, message.stanzaId]);
}

/**
 * Runs a named WhatsApp matrix case once uninterrupted and once after every
 * source durable edge. The caller selects the scan that races its transition;
 * this helper never substitutes a model for the on-disk daemon fixture.
 */
export async function forEachWhatsAppDurableEdge(
  name: string,
  scenario: (fixture: PhaseDCutoverFixture, attempt: WhatsAppCutoverAttempt) => Promise<void>,
): Promise<void> {
  for (const edge of [undefined, ...DURABLE_CUTOVER_EDGES] as const) {
    const fixture = await PhaseDCutoverFixture.create('whatsapp');
    let fired = false;
    try {
      const sourceTurn = async (scopeId = 'chat-cutover') =>
        fixture.sourceTurn({ source: 'whatsapp', accountId: fixture.accountId, scopeId });
      const sourceAtDurableEdge = async (scopeId = 'chat-cutover') => {
        if (edge === undefined) return sourceTurn(scopeId);
        await fixture.setFailpoint((at) => {
          if (at !== edge) return;
          fired = true;
          throw new Error(`${name}: crash at ${edge}`);
        });
        await assert.rejects(() => sourceTurn(scopeId), new RegExp(`${name}: crash at ${edge}`));
        const journal = await fixture.journal();
        await fixture.restart();
        await sourceTurn(scopeId);
        assert.ok((await fixture.journal()).length >= journal.length, `${name}: ${edge} reopens the fake journal`);
      };
      await scenario(fixture, { edge, sourceTurn, sourceAtDurableEdge });
      if (edge !== undefined) assert.equal(fired, true, `${name}: ${edge} was reached by the concurrent source scan`);
    } finally {
      await fixture.dispose();
    }
  }
}

export function assertWhatsAppMultiset(
  fixture: PhaseDCutoverFixture,
  expected: Readonly<{
    readonly raw: readonly WhatsAppCutoverMessage[];
    readonly admissions: readonly Readonly<{ message: WhatsAppCutoverMessage; version: number }>[];
    readonly decisions?: readonly Readonly<{ message: WhatsAppCutoverMessage; version: number }>[];
    readonly deliveries?: readonly Readonly<{ message: WhatsAppCutoverMessage; version: number }>[];
  }>,
): void {
  const database = fixture.store.database;
  const raw = database
    .prepare('SELECT message_id FROM whatsapp_occurrences ORDER BY message_id')
    .all()
    .map((row) => (row as { message_id: string }).message_id);
  assert.deepEqual(raw, expected.raw.map(whatsappRawKey).sort(), 'exact raw WhatsApp key multiset');

  const admissions = database
    .prepare('SELECT message_id, rule_version FROM whatsapp_rule_admissions ORDER BY message_id, rule_version')
    .all()
    .map((row) => {
      const value = row as { message_id: string; rule_version: number };
      return `${value.message_id}\u0000${value.rule_version}`;
    });
  assert.deepEqual(
    admissions,
    expected.admissions.map(({ message, version }) => `${whatsappRawKey(message)}\u0000${version}`).sort(),
    'exact raw-key/rule-version admission multiset',
  );

  if (expected.decisions !== undefined) {
    const decisions = database
      .prepare('SELECT whatsapp_message_id, rule_version FROM decisions ORDER BY whatsapp_message_id, rule_version')
      .all()
      .map((row) => {
        const value = row as { whatsapp_message_id: string; rule_version: number };
        return `${value.whatsapp_message_id}\u0000${value.rule_version}`;
      });
    assert.deepEqual(
      decisions,
      expected.decisions.map(({ message, version }) => `${whatsappRawKey(message)}\u0000${version}`).sort(),
      'exact raw-key/rule-version decision multiset',
    );
  }

  if (expected.deliveries !== undefined) {
    const deliveries = database
      .prepare(
        `SELECT deliveries.whatsapp_message_id, deliveries.rule_version
           FROM deliveries JOIN dryrun_log ON dryrun_log.delivery_id = deliveries.id
          ORDER BY deliveries.whatsapp_message_id, deliveries.rule_version`,
      )
      .all()
      .map((row) => {
        const value = row as { whatsapp_message_id: string; rule_version: number };
        return `${value.whatsapp_message_id}\u0000${value.rule_version}`;
      });
    assert.deepEqual(
      deliveries,
      expected.deliveries.map(({ message, version }) => `${whatsappRawKey(message)}\u0000${version}`).sort(),
      'exact raw-key/rule-version dry-run delivery multiset',
    );
  }
}

export function headGeneration(fixture: PhaseDCutoverFixture): number | undefined {
  const row = fixture.store.database
    .prepare('SELECT committed_generation FROM whatsapp_snapshot_heads WHERE account_id = ?')
    .get(fixture.accountId) as { committed_generation: number } | undefined;
  return row?.committed_generation;
}
