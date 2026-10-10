import assert from 'node:assert/strict';
import { DURABLE_CUTOVER_EDGES, type DurableCutoverEdge } from '../../src/runtime/cutover-failpoint.ts';
import { PhaseDCutoverFixture, type WhatsAppCutoverMessage } from './phase-d-cutover.ts';

export type WhatsAppCutoverAttempt = Readonly<{
  /** The one concurrent production scan which is crashed/restarted at this durable edge. */
  readonly sourceAtDurableEdge: (chatJid?: string) => Promise<void>;
  /** A normal production source turn used to prepare the named transition. */
  readonly sourceTurn: (chatJid?: string) => Promise<void>;
  /** Proves a claimed P prevents both checked-copy reads and durable writes across a restart. */
  readonly assertSourceEdgeUnreachable: (chatJid?: string) => Promise<void>;
  readonly edge: DurableCutoverEdge | undefined;
}>;

type DurableRun = 'completed' | 'fired' | 'unreachable';
type DurableRunKey = DurableCutoverEdge | 'no-crash';

const durableRuns = new Map<string, Map<DurableRunKey, DurableRun>>();

function recordDurableRun(cell: string, edge: DurableRunKey, result: DurableRun): void {
  const runs = durableRuns.get(cell) ?? new Map<DurableRunKey, DurableRun>();
  runs.set(edge, result);
  durableRuns.set(cell, runs);
}

/** Makes adding a matrix cell without the no-crash and every-edge probe a test failure. */
export function assertWhatsAppDurableEdgeCoverage(cells: readonly string[]): void {
  for (const cell of cells) {
    const runs = durableRuns.get(cell);
    assert.equal(runs?.get('no-crash'), 'completed', `${cell}: ran uninterrupted through the durable-edge harness`);
    for (const edge of DURABLE_CUTOVER_EDGES)
      assert.ok(
        runs?.get(edge) === 'fired' || runs?.get(edge) === 'unreachable',
        `${cell}: ${edge} fired or was asserted unreachable`,
      );
  }
}

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
  input: Readonly<{ cell?: string }> = {},
): Promise<void> {
  const cell = input.cell ?? name;
  for (const edge of [undefined, ...DURABLE_CUTOVER_EDGES] as const) {
    const fixture = await PhaseDCutoverFixture.create('whatsapp');
    let fired = false;
    let result: DurableRun | undefined;
    try {
      // The source registry schedules concrete `chat:<raw JID>` scopes. Keeping
      // that prefix here matters: an unfenced made-up scope would let the worker
      // reach the checked copy and make a claimed-P proof meaningless.
      const sourceTurn = async (chatJid = 'chat-cutover') =>
        fixture.sourceTurn({ source: 'whatsapp', accountId: fixture.accountId, scopeId: `chat:${chatJid}` });
      const sourceAtDurableEdge = async (chatJid = 'chat-cutover') => {
        if (edge === undefined) return sourceTurn(chatJid);
        await fixture.setFailpoint((at) => {
          if (at !== edge) return;
          fired = true;
          throw new Error(`${name}: crash at ${edge}`);
        });
        await assert.rejects(() => sourceTurn(chatJid), new RegExp(`${name}: crash at ${edge}`));
        const journal = await fixture.journal();
        await fixture.restart();
        await sourceTurn(chatJid);
        assert.ok((await fixture.journal()).length >= journal.length, `${name}: ${edge} reopens the fake journal`);
        result = 'fired';
      };
      const assertSourceEdgeUnreachable = async (chatJid = 'chat-cutover') => {
        if (edge === undefined) {
          const calls = fixture.calls.length;
          const writes = totalChanges(fixture);
          await sourceTurn(chatJid);
          assert.equal(fixture.calls.length, calls, `${name}: fenced no-crash pass reads no checked copy`);
          assert.equal(totalChanges(fixture), writes, `${name}: fenced no-crash pass writes nothing`);
          return;
        }
        await fixture.setFailpoint((at) => {
          if (at !== edge) return;
          fired = true;
          throw new Error(`${name}: unreachable crash at ${edge}`);
        });
        // `setFailpoint` rebuilds the test runtime; exclude that fixture setup
        // write so this is an exact observation of the source turn itself.
        const calls = fixture.calls.length;
        const writes = totalChanges(fixture);
        const journal = await fixture.journal();
        await assert.doesNotReject(() => sourceTurn(chatJid), `${name}: ${edge} is unreachable while fenced`);
        assert.equal(fired, false, `${name}: ${edge} is not reached while fenced`);
        assert.equal(fixture.calls.length, calls, `${name}: ${edge} reads no checked copy while fenced`);
        assert.equal(totalChanges(fixture), writes, `${name}: ${edge} writes nothing while fenced`);
        await fixture.restart();
        const restartedWrites = totalChanges(fixture);
        await sourceTurn(chatJid);
        assert.equal(fixture.calls.length, calls, `${name}: restart at ${edge} reads no checked copy while fenced`);
        assert.equal(totalChanges(fixture), restartedWrites, `${name}: restart at ${edge} writes nothing while fenced`);
        assert.deepEqual(await fixture.journal(), journal, `${name}: restart at ${edge} preserves the fake journal`);
        result = 'unreachable';
      };
      await scenario(fixture, { edge, sourceTurn, sourceAtDurableEdge, assertSourceEdgeUnreachable });
      if (edge === undefined) recordDurableRun(cell, 'no-crash', 'completed');
      else {
        if (result === undefined) throw new Error(`${name}: ${edge} was neither fired nor asserted unreachable`);
        recordDurableRun(cell, edge, result);
      }
    } finally {
      await fixture.dispose();
    }
  }
}

function totalChanges(fixture: PhaseDCutoverFixture): number {
  return Number((fixture.store.database.prepare('SELECT total_changes() AS count').get() as { count: number }).count);
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
    .prepare(
      "SELECT message_id, rule_version FROM whatsapp_rule_admissions WHERE admission = 'admitted' ORDER BY message_id, rule_version",
    )
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
