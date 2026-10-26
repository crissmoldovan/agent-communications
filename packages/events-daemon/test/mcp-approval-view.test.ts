import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventControlClient } from '../src/control/client.ts';
import { approvalViewForAgent } from '../src/mcp/agent-approval-view.ts';
import {
  cli,
  DAVID,
  dryRun,
  type LaneHarness,
  RULE,
  readDatabase,
  rule,
  structured,
  tool,
  withLaneOwner,
} from './support/lane-harness.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * 0.34.0 design B7: `events_approval_view` gave an MCP client a fresh, usable challenge, and a view's challenge also
 * answers the `approve` wire. No MCP tool approves, but an agent with a shell could carry that challenge to the control
 * socket. Now the MCP view is the preview alone: the owner issues no challenge for it, so nothing an agent receives
 * can answer `approve`, and a challenge the person is answering at their terminal is not replaced by an agent's look.
 * The person's own view (`approval view`, in the app or at the terminal) and `approve <approval-id>` are unchanged.
 */

interface Prepared {
  readonly approvalId: string;
  readonly binding: { readonly digest: string };
}

/** A rule's activation, prepared and waiting for the person, as an agent prepares it over MCP. */
async function pendingRule(harness: LaneHarness): Promise<Prepared> {
  await harness.control.request('target-add', { document: dryRun });
  await harness.control.request('rule-create', { document: rule(1, [dryRun]) });
  return (await harness.control.request('rule-enable', { ruleId: RULE, version: 1 })) as Prepared;
}

function challengeRow(stateDir: string, approvalId: string): unknown {
  return readDatabase(stateDir, (database) => {
    const row = database
      .prepare('SELECT state, origin, challenge_hash, expires_at FROM activation_view_challenges WHERE approval_id = ?')
      .get(approvalId);
    return row === undefined ? undefined : { ...row };
  });
}

/** Every string anywhere in a value: what an agent holds after reading it. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

test('B7: the MCP approval view is the preview alone — no challenge is issued for it, and nothing in it approves', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    const planned = await pendingRule(harness);
    const { approvalId } = planned;
    const digest = planned.binding.digest;
    const david = await harness.window(DAVID);

    const viewed = structured(await tool(david, 'events_approval_view', { approvalId, digest }));
    t.diagnostic(`events_approval_view: ${JSON.stringify(viewed)}`);
    assert.deepEqual(Object.keys(viewed).sort(), ['approvalId', 'digest', 'kind', 'preview']);
    assert.deepEqual([viewed.kind, viewed.approvalId, viewed.digest], ['READY', approvalId, digest]);
    assert.equal((viewed.preview as { kind?: string }).kind, 'rule', 'the preview the person will approve');
    assert.doesNotMatch(JSON.stringify(viewed), /challenge/iu, 'no challenge, and no selector carrying one');
    assert.equal(challengeRow(stateDir, approvalId), undefined, 'the owner issued no challenge for the view');

    // Every value the agent now holds, tried as the answer over the wire on each channel: none approves anything.
    for (const answer of new Set(stringsIn(viewed)))
      for (const clientName of ['terminal-approval', 'app-approval-screen', 'events-cli'])
        await assert.rejects(
          new EventControlClient({ stateDir, clientName }).request('approve', { approvalId, answer }),
          (error: unknown) => (error as { code?: string }).code === 'APPROVAL_VOID',
          `${clientName}: ${answer}`,
        );
    assert.deepEqual(
      ((await harness.control.request('rules-list')) as { version: number; state: string | null }[]).map(
        (row) => `${row.version}:${row.state}`,
      ),
      ['1:null'],
      'the rule is still waiting for the person',
    );

    // Unknown and changed approvals keep their plain variants over MCP.
    assert.deepEqual(structured(await tool(david, 'events_approval_view', { approvalId, digest: '0'.repeat(64) })), {
      kind: 'DIGEST_MISMATCH',
    });
    assert.deepEqual(
      structured(await tool(david, 'events_approval_view', { approvalId: `ap_${'0'.repeat(26)}`, digest })),
      { kind: 'STALE_APPROVAL' },
    );
  });
});

test('B7: an agent’s MCP view leaves the challenge the person is answering at their terminal theirs, and approve works', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const { stateDir } = harness;
    const planned = await pendingRule(harness);
    const { approvalId } = planned;
    const digest = planned.binding.digest;

    // The person's own view still carries the challenge the app strips and the terminal shows.
    const shown = await cli(stateDir, ['approval', 'view', approvalId, '--digest', digest, '--json']);
    assert.equal(shown.code, 0, shown.err);
    const personal = JSON.parse(shown.out) as { kind: string; challenge?: { challenge?: unknown } };
    assert.equal(personal.kind, 'READY');
    assert.equal(typeof personal.challenge?.challenge, 'string', 'the person’s view keeps its challenge');

    // The person starts `approve <approval-id>`: the terminal flow issues the challenge they will type.
    const person = new EventControlClient({ stateDir, clientName: 'terminal-approval' });
    const start = (await person.request('approve-challenge', { approvalId })) as { challenge: string };
    const before = challengeRow(stateDir, approvalId);
    assert.equal((before as { origin?: string } | undefined)?.origin, 'terminal');

    // Meanwhile an agent looks over MCP: nothing is issued, so the person's challenge is not replaced.
    const david = await harness.window(DAVID);
    const viewed = structured(await tool(david, 'events_approval_view', { approvalId, digest }));
    assert.equal(viewed.kind, 'READY');
    assert.deepEqual(challengeRow(stateDir, approvalId), before, 'the MCP view left the terminal challenge as it was');

    // The person types it: approved at the terminal, as before.
    const completed = (await person.request('approve', { approvalId, answer: start.challenge })) as {
      status: string;
    };
    assert.equal(completed.status, 'completed');
  });
});

test('B7: an owner from before 0.34.0 still issues a view challenge; the MCP server passes the agent none of it', () => {
  const challenge = 'C'.repeat(32);
  const old = {
    kind: 'READY',
    approvalId: 'ap_00000000000000000000000000',
    digest: 'd'.repeat(64),
    preview: { documentVersion: 1, kind: 'enable-all', switchGeneration: 0, ruleVersions: [] },
    pendingTargetSelectors: [{ kind: 'pending-activation', targetId: 'log', challenge }],
    challenge: { approvalId: 'ap_00000000000000000000000000', digest: 'd'.repeat(64), challenge, expiresAt: 1 },
    layaJudge: { template: 'kept' },
  };
  const forAgent = approvalViewForAgent(old);
  assert.deepEqual(forAgent, {
    kind: 'READY',
    approvalId: old.approvalId,
    digest: old.digest,
    preview: old.preview,
    layaJudge: old.layaJudge,
  });
  assert.doesNotMatch(JSON.stringify(forAgent), new RegExp(challenge, 'u'));
  for (const kind of ['STALE_APPROVAL', 'DIGEST_MISMATCH', 'CHALLENGE_EXPIRED'])
    assert.deepEqual(approvalViewForAgent({ kind }), { kind });
});
