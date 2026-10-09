import assert from 'node:assert/strict';
import type { SlackEventSource } from '@agentcomms/slack';
import { DURABLE_CUTOVER_EDGES, type DurableCutoverEdge } from '../../src/runtime/cutover-failpoint.ts';
import type { SourceScope } from '../../src/sources/contracts.ts';
import { PhaseDCutoverFixture } from './phase-d-cutover.ts';

export type SlackDurableEdge = DurableCutoverEdge | undefined;

/**
 * D12's crash oracle must use the same SQLite state directory and provider
 * journal after process loss.  A non-firing seam is a test error: it is not a
 * reason to silently omit an edge from the matrix.
 */
export async function forEachSlackDurableEdge(
  run: (fixture: PhaseDCutoverFixture, edge: SlackDurableEdge) => Promise<void>,
): Promise<void> {
  for (const edge of [undefined, ...DURABLE_CUTOVER_EDGES] as const) {
    const fixture = await PhaseDCutoverFixture.create('slack');
    try {
      await run(fixture, edge);
    } finally {
      await fixture.dispose();
    }
  }
}

/** Runs the production Slack worker, crashes it at one durable write edge, then reopens the same fixture. */
export async function sourceTurnThroughSlackDurableEdge(
  fixture: PhaseDCutoverFixture,
  edge: SlackDurableEdge,
  scope?: SourceScope,
  input: Readonly<{ expectFire?: boolean }> = {},
): Promise<void> {
  const turn = () => fixture.sourceTurn(scope);
  if (edge === undefined) {
    await turn();
    return;
  }
  let fired = false;
  await fixture.setFailpoint((at) => {
    if (at !== edge) return;
    fired = true;
    throw new Error(`cut-over crash:${edge}`);
  });
  if (input.expectFire === false) {
    await turn();
    assert.equal(fired, false, `${edge} is not reached by this already-staged continuation`);
    await fixture.setFailpoint(undefined);
    return;
  }
  await assert.rejects(turn, new RegExp(`cut-over crash:${edge}`), edge);
  assert.equal(fired, true, `${edge} is reachable for this matrix cell`);
  const journal = await fixture.journal();
  await fixture.restart();
  await turn();
  assert.ok((await fixture.journal()).length >= journal.length, `${edge} retains the fake-provider journal`);
}

/**
 * The real scheduler catches a source-owner failure, records content-free
 * health, and retries after restart; unlike the direct owner seam it does not
 * rethrow the injected crash to its caller.
 */
export async function schedulerTurnThroughSlackDurableEdge(
  fixture: PhaseDCutoverFixture,
  edge: SlackDurableEdge,
): Promise<void> {
  if (edge === undefined) {
    await fixture.schedulerTurn();
    return;
  }
  let fired = false;
  await fixture.setFailpoint((at) => {
    if (at !== edge) return;
    fired = true;
    throw new Error(`cut-over crash:${edge}`);
  });
  await fixture.schedulerTurn();
  assert.equal(fired, true, `${edge} is reached by the scheduler-owned collection`);
  assert.equal(
    (
      fixture.store.database
        .prepare('SELECT kind FROM operational_records WHERE id = ?')
        .get(`scheduler:slack:${fixture.accountId}`) as { kind: string } | undefined
    )?.kind,
    'agentcomms.source.degraded',
    `${edge} is contained by the scheduler as a durable source failure`,
  );
  const journal = await fixture.journal();
  await fixture.restart();
  // The scheduler persisted its retry eligibility rather than rethrowing the
  // source failure. Advance to that next ordinary owner turn after restart.
  fixture.now.value += 1;
  await fixture.schedulerTurn();
  assert.ok((await fixture.journal()).length >= journal.length, `${edge} resumes against the same provider journal`);
}

export function slackScope(fixture: PhaseDCutoverFixture, conversationId: string): SourceScope {
  return { source: 'slack', accountId: fixture.accountId, scopeId: `slack:${fixture.accountId}:${conversationId}` };
}

/** Exact raw occurrence identity and version admission multiset, not just a cursor. */
export function assertSlackOccurrences(
  fixture: PhaseDCutoverFixture,
  expected: readonly Readonly<{ ts: string; version: number }>[],
): void {
  const rows = fixture.store.database
    .prepare(
      `SELECT ingest.dedupe_key, decisions.rule_version
         FROM decisions
         JOIN ingest ON ingest.event_id = decisions.event_id
        WHERE ingest.type = 'slack.message.posted'
        ORDER BY ingest.dedupe_key, decisions.rule_version`,
    )
    .all() as Array<{ dedupe_key: string; rule_version: number }>;
  assert.equal(rows.length, expected.length, 'the exact Slack timestamp/version admission multiset has no extra row');
  const actual = rows
    .map((row) => {
      const match = expected.find(
        (candidate) => row.dedupe_key.includes(candidate.ts) && row.rule_version === candidate.version,
      );
      assert.ok(match, `unexpected Slack occurrence/version ${row.dedupe_key}/${row.rule_version}`);
      return `${match.ts}:${match.version}`;
    })
    .sort();
  assert.deepEqual(
    actual,
    expected.map((entry) => `${entry.ts}:${entry.version}`).sort(),
    'each Slack timestamp is admitted exactly once by its expected version',
  );
}

type SlackFixtureMessage = Awaited<ReturnType<SlackEventSource['history']>>['messages'][number];

export function slackMessage(input: {
  ts: string;
  threadTs?: string | null;
  replyCount?: number;
  text?: string;
}): SlackFixtureMessage {
  return {
    ts: input.ts,
    threadTs: input.threadTs ?? null,
    replyCount: input.replyCount ?? 0,
    text: `<untrusted-content>${input.text ?? input.ts}</untrusted-content>`,
    author: { name: null, app: false, external: false },
    truncated: false,
    mismatch: false,
    unrenderable: false,
    editedTs: null,
    mentions: [],
    files: [],
  };
}
