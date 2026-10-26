import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalFullRuleDocument, canonicalTarget, targetLane } from '../src/domain/activation-documents.ts';
import { canonicalSessionTarget, isSessionFolder } from '../src/domain/session-target.ts';

/**
 * The agent-session target's document (0.33.0 design §3.5–§3.6): exact keys, its defaults written out, the mode the
 * relay may run it in, and a rule that maps every field its context reads.
 */

const DAY = 86_400_000;
const RETENTION = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
};

const session = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  targetId: 'acme',
  version: 1,
  kind: 'session',
  find: { folder: '/example/home/acme' },
  ifNone: 'start',
  provider: 'claude',
  ...overrides,
});

const rule = (targets: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  ruleId: 'invoices',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: ['ibx_SESSIONDOMAIN01'],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } },
  targets,
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: RETENTION,
  ...extra,
});

test('SESSION-D1: a session target canonicalises with its defaults written out', () => {
  assert.deepEqual(canonicalTarget(session()), {
    targetId: 'acme',
    version: 1,
    kind: 'session',
    find: { folder: '/example/home/acme' },
    ifNone: 'start',
    provider: 'claude',
    mode: 'manual',
    ifBusy: 'queue',
    context: [],
  });
  const lane = canonicalTarget(session({ find: { lane: 'david' }, ifNone: undefined, provider: 'codex' }));
  assert.equal(lane.kind === 'session' ? lane.ifNone : undefined, 'queue-only');
  assert.equal(targetLane(lane), 'david', 'a session found by a lane carries the lane');
  assert.equal(targetLane(canonicalTarget(session())), undefined);
});

test('SESSION-D2: refusals name what is wrong', () => {
  const refuses = (overrides: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => canonicalSessionTarget(session(overrides)), pattern, JSON.stringify(overrides));
  refuses({ mode: 'bypassPermissions' }, /never fixes bypassPermissions/u);
  refuses({ mode: 'yolo' }, /mode is manual or acceptEdits or plan/u);
  refuses({ find: { lane: 'david' }, ifNone: 'start' }, /never started/u);
  refuses({ find: { folder: '/example/home/acme', lane: 'x' } }, /folder.*or by \{ lane \}/u);
  refuses({ find: { folder: 'relative/acme' } }, /absolute path/u);
  refuses({ find: { folder: '/example/home/../etc' } }, /absolute path/u);
  refuses({ find: { lane: 'Not A Lane' } }, /lane name/u);
  refuses({ provider: undefined }, /names its provider/u);
  refuses({ provider: 'gemini' }, /provider is claude or codex/u);
  refuses({ ifBusy: 'interrupt' }, /ifBusy is queue or queue-only/u);
  refuses({ context: [{ prompt: 'x' }] }, /context: a context part is one of/u);
  refuses({ context: [{ file: 'relative.md' }] }, /absolute path/u);
  refuses({ instruction: '' }, /instruction is non-empty text/u);
  refuses({ extra: 1 }, /has no extra field/u);
  for (const folder of ['/', '/a/', '/a//b', '/a/./b', '']) assert.equal(isSessionFolder(folder), false, folder);
  assert.equal(isSessionFolder('/example/home/acme'), true);
});

test('SESSION-D3: a rule maps every field its session target reads, or is refused naming them', () => {
  const reads = session({
    context: [
      { fields: ['/subject', '/from/address'] },
      {
        generate: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', instruction: 'x', from: ['/body'] },
      },
    ],
  });
  assert.throws(
    () => canonicalFullRuleDocument(rule([reads])),
    /the session target acme reads \/body, which the rule's mapping does not keep/u,
  );
  const mapped = canonicalFullRuleDocument(
    rule([reads], { mapping: { from: { $path: '/from' }, subject: { $path: '/subject' }, body: { $path: '/body' } } }),
  );
  assert.equal(mapped.targets[0]?.kind, 'session');
});

test('SESSION-D4: a session target that can leave an item in the Queue gives its rule a queue retention', () => {
  assert.throws(
    () => canonicalFullRuleDocument(rule([session({ ifBusy: 'queue-only' })])),
    /a rule with a queue target sets retention.queueMs/u,
  );
  const queued = canonicalFullRuleDocument(
    rule([session({ ifBusy: 'queue-only' })], { retention: { ...RETENTION, queueMs: 7 * DAY } }),
  );
  assert.equal(queued.retention.queueMs, 7 * DAY);
  assert.throws(
    () => canonicalFullRuleDocument(rule([session()], { retention: { ...RETENTION, queueMs: 7 * DAY } })),
    /queueMs applies only/u,
    'a session that never queues has no queue retention',
  );
  // Its fallback item shows from whom and the subject, so the mapping must keep them (Q4).
  assert.throws(
    () =>
      canonicalFullRuleDocument(
        rule([session({ find: { lane: 'david' }, ifNone: 'queue-only' })], {
          mapping: { subject: { $path: '/subject' } },
          retention: { ...RETENTION, queueMs: 7 * DAY },
        }),
      ),
    /needs the rule's mapping to include from.address/u,
  );
});

test('SESSION-D5: one target carries a lane, a session target and a queue target alike', () => {
  assert.throws(
    () =>
      canonicalFullRuleDocument(
        rule(
          [
            session({ find: { lane: 'david' }, ifNone: 'queue-only' }),
            {
              targetId: 'q',
              version: 1,
              kind: 'queue',
              retentionMs: 7 * DAY,
              show: 'summary',
              lane: { name: 'david' },
            },
          ],
          { retention: { ...RETENTION, queueMs: 7 * DAY } },
        ),
      ),
    /lane david is carried by two targets of this rule/u,
  );
});
