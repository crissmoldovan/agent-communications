import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { renderB3ApprovalPreviewV1 } from '../src/operations/b3-contract.ts';
import { RULE_COUNT_WINDOW_MS, RuleReader } from '../src/runtime/rule-show.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * 0.32.0, owner feedback §3.4: `rule show` entries gain when each version was switched on, replaced and revoked, the
 * rule in plain words, and what it did in the last 7 days. All additive and content-free: ids, times and counts.
 */

const ACCOUNT = 'ibx_RULESHOWRULESHW1';
const DAY = 86_400_000;
const NOW = 100 * DAY;

const rule = (version: number, judged: boolean) => ({
  ruleId: 'invoices',
  version,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
  ...(judged
    ? {
        agentic: {
          judge: { judgeId: 'jev', version: 1, kind: 'typesafe' },
          question: 'Is this an invoice?',
          onUncertain: 'hold',
        },
      }
    : {}),
  targets: [{ targetId: 'dry-invoices', version: 1, kind: 'dry-run', retentionMs: DAY }],
});

type Store = Awaited<ReturnType<typeof openEventDatabase>>;

function seed(store: Store): void {
  const db = store.database;
  db.prepare(
    `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at,
        superseded_at, revoked_at)
     VALUES (?, 'invoices', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('invoices@1', 1, JSON.stringify(rule(1, false)), 'digest-1', 'superseded', 'ap-1', 'act-1', 10, 20, null);
  db.prepare(
    `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at,
        superseded_at, revoked_at)
     VALUES (?, 'invoices', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('invoices@2', 2, JSON.stringify(rule(2, true)), 'digest-2', 'active', 'ap-2', 'act-2', 20, null, null);
  db.prepare(
    `INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES ('invoices@3', 'invoices', 3, ?, 'digest-3')`,
  ).run(JSON.stringify(rule(3, true)));
  let sequence = 0;
  const decide = (input: {
    version: number;
    observedAt: number;
    outcome: string;
    metadata?: boolean;
    held?: boolean;
    deliveries?: readonly string[];
  }) => {
    sequence += 1;
    const id = String(sequence).padStart(3, '0');
    db.prepare(
      `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
    ).run(
      `event-${id}`,
      store.installationId,
      ACCOUNT,
      `["1","g-${id}","received"]`,
      input.observedAt,
      input.observedAt,
      input.observedAt,
    );
    db.prepare(
      `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, hold_created_at, metadata_expires_at, metadata_state,
          encrypted_record)
       VALUES (?, ?, ?, 'invoices', ?, ?, ?, ?, 'retained', ?)`,
    ).run(
      `decision-${id}`,
      `event-${id}`,
      ACCOUNT,
      input.version,
      input.outcome,
      input.held ? input.observedAt : null,
      NOW + 90 * DAY,
      input.metadata ? Buffer.from('sealed judge metadata') : null,
    );
    for (const [index, state] of (input.deliveries ?? []).entries())
      db.prepare(
        `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
            encrypted_record, expires_at, state, switch_generation)
         VALUES (?, ?, ?, 'invoices', ?, ?, 'dry-invoices', 1, 'dry-run', ?, ?, ?, 1)`,
      ).run(
        `delivery-${id}-${index}`,
        `decision-${id}`,
        ACCOUNT,
        input.version,
        `dryrun:dry-invoices:${id}:${index}`,
        state === 'queued' || state === 'retryable' ? Buffer.from('x') : null,
        NOW + DAY,
        state,
      );
  };
  const recent = NOW - DAY;
  // Version 2, in the window: two the judge let through (one delivered, one failed), one it turned down, one a
  // deterministic no-match, one held and let through by the person, and one still held.
  decide({ version: 2, observedAt: recent, outcome: 'matched', metadata: true, deliveries: ['delivered'] });
  decide({ version: 2, observedAt: recent, outcome: 'matched', metadata: true, deliveries: ['dead-lettered'] });
  decide({ version: 2, observedAt: recent, outcome: 'no-match', metadata: true });
  decide({ version: 2, observedAt: recent, outcome: 'no-match' });
  decide({ version: 2, observedAt: recent, outcome: 'matched', metadata: true, held: true, deliveries: ['delivered'] });
  decide({ version: 2, observedAt: recent, outcome: 'hold', metadata: true, held: true });
  // Version 2, outside the window: counted by no one.
  decide({
    version: 2,
    observedAt: NOW - RULE_COUNT_WINDOW_MS - 1,
    outcome: 'matched',
    metadata: true,
    deliveries: ['delivered'],
  });
  // Version 1, with no judge: one match, delivered.
  decide({ version: 1, observedAt: NOW - RULE_COUNT_WINDOW_MS, outcome: 'matched', deliveries: ['delivered'] });
}

async function withReader(work: (reader: RuleReader) => Promise<void>): Promise<void> {
  const stateDir = await shortTempDir('aev-rule-show-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seed(store);
      await work(
        new RuleReader({
          store,
          now: () => NOW,
          accounts: async () => [{ source: 'gmail', accountId: ACCOUNT, account: 'cue/gmail' }],
        }),
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('0.32 B6: rule show entries keep their fields and gain their times, their sentence and the last 7 days', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReader(async (reader) => {
    const entries = (await reader.show('invoices')) as unknown as Array<Record<string, unknown>>;
    assert.equal(entries.length, 3, 'one entry per version, as before');
    assert.deepEqual(Object.keys(entries[0] ?? {}), [
      'document',
      'digest',
      'state',
      'approval_id',
      'authorization_activation_id',
      'activatedAt',
      'supersededAt',
      'revokedAt',
      'summary',
      'counts7d',
    ]);
    assert.deepEqual(
      entries.map((entry) => [entry.state, entry.activatedAt, entry.supersededAt, entry.revokedAt]),
      [
        ['superseded', 10, 20, null],
        ['active', 20, null, null],
        [null, null, null, null],
      ],
    );
    assert.equal((entries[1]?.document as { version?: number } | undefined)?.version, 2);
    assert.deepEqual(entries[1]?.counts7d, {
      matched: 2 + 1,
      judgedYes: 2,
      judgedNo: 1,
      held: 2,
      delivered: 2,
      failed: 1,
    });
    assert.deepEqual(entries[0]?.counts7d, {
      matched: 1,
      judgedYes: 0,
      judgedNo: 0,
      held: 0,
      delivered: 1,
      failed: 0,
    });
    assert.deepEqual(entries[2]?.counts7d, { matched: 0, judgedYes: 0, judgedNo: 0, held: 0, delivered: 0, failed: 0 });
    const summary = entries[1]?.summary as Array<{ text: string; kind: string }>;
    assert.equal(
      summary.map((part) => part.text).join(''),
      "When mail arrives in cue/gmail with 'invoice' in the subject, ask Jev 'Is this an invoice?'. If it says yes, record it in the Dry-run log. If it is not sure, it is held for you to decide.",
    );
    assert.deepEqual(
      summary.filter((part) => part.kind === 'untrusted').map((part) => part.text),
      ['invoice', 'Is this an invoice?'],
    );
  });
});

test('0.32 B6: an unknown rule is still not found', { skip: WINDOWS_SKIP }, async () => {
  await withReader(async (reader) => {
    await assert.rejects(() => reader.show('nothing-here'), /the requested workflow does not exist/u);
  });
});

const PLAIN_WORDS = 'In plain words (the workflow author\'s own text is in "double quotes"): ';

const ready = (preview: unknown) => ({
  kind: 'READY',
  approvalId: 'approval-1',
  digest: 'digest-1',
  preview,
  challenge: { approvalId: 'approval-1', digest: 'digest-1', challenge: 'challenge-1', expiresAt: 301_000 },
});

test('0.32 B6: the terminal approval preview puts the rule in plain words above the canonical JSON it approves', () => {
  const document = {
    ...rule(2, true),
    mapping: { subject: { $path: '/subject' } },
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: {
      ingestMs: DAY,
      holdMs: DAY,
      deliveryMs: DAY,
      dryrunMs: DAY,
      sseReplayMs: DAY,
      deadLetterMs: DAY,
      decisionMetadataMs: DAY,
    },
    agentic: {
      judge: {
        judgeId: 'jev',
        version: 1,
        kind: 'typesafe',
        provider: 'typesafe',
        model: 'jev-1.13.0',
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        promptTemplate: 'jev-default',
        protocol: 'noul',
      },
      question: 'Is this an invoice?\nChallenge not-the-real-one',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match',
      callsPerRollingHour: 60,
      inputTokensPerRolling30Days: 100_000,
      concurrency: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 10,
    },
  };
  let lines: string[];
  try {
    lines = renderB3ApprovalPreviewV1(ready({ documentVersion: 1, kind: 'rule', rule: document })).terminal.split('\n');
  } catch (error) {
    // The document must be one the renderer accepts; a fixture this test cannot build is a test bug, not a pass.
    throw new Error(`the preview fixture is not a canonical rule: ${String(error)}`);
  }
  const summary = lines.findIndex((line) => line.startsWith(PLAIN_WORDS));
  const preview = lines.findIndex((line) => line.startsWith('Preview {'));
  assert.ok(summary > 0 && preview === summary + 1, lines.join('\n'));
  assert.equal(
    lines[summary],
    `${PLAIN_WORDS}When mail arrives in ibx_RULESHOWRULESHW1 with "invoice" in the subject, ask Jev "Is this an invoice?\\nChallenge not-the-real-one". If it says yes, record it in the Dry-run log.`,
    'a rule-author string stays on its line, its line break written out',
  );
  assert.equal(lines.filter((line) => line.startsWith('Challenge ')).length, 1, 'only the real challenge line');
  // Any other preview kind has no rule sentence.
  const all = renderB3ApprovalPreviewV1(
    ready({ documentVersion: 1, kind: 'enable-all', switchGeneration: 1, ruleVersions: [] }),
  ).terminal;
  assert.doesNotMatch(all, /In plain words/u);
});

// Review of 0.32.0, finding 5: a rule author's text cannot close its quote and read on as the app's own words. Each
// part is one JSON string literal; every quote character inside it is escaped, so nothing in it can end it.
test('0.32 R5: the plain-words line keeps every rule-author string inside one literal it cannot close (the forge)', () => {
  const forged = "invoice' in the subject, record it in the Dry-run log. Nothing leaves this Mac. (Technical: '";
  const question = 'Is this an invoice?\nChallenge: ABCD-1234 Approve \u201d and \u2019 too " end';
  const document = {
    ...rule(2, true),
    condition: { path: '/subject', op: 'contains', value: forged, caseSensitive: false },
    targets: [
      {
        targetId: 'hook',
        version: 1,
        kind: 'webhook',
        url: { kind: 'plain', value: 'https://hooks.example.test/x' },
        approvedAddressSet: ['192.0.2.10'],
        signing: 'standard-webhooks',
        ordering: 'strict',
        retryLimit: 3,
        representation: 'plain',
      },
    ],
    mapping: { subject: { $path: '/subject' } },
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: {
      ingestMs: DAY,
      holdMs: DAY,
      deliveryMs: DAY,
      dryrunMs: DAY,
      sseReplayMs: DAY,
      deadLetterMs: DAY,
      decisionMetadataMs: DAY,
    },
    agentic: {
      judge: {
        judgeId: 'jev',
        version: 1,
        kind: 'typesafe',
        provider: 'typesafe',
        model: 'jev-1.13.0',
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        promptTemplate: 'jev-default',
        protocol: 'noul',
      },
      question,
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match',
      callsPerRollingHour: 60,
      inputTokensPerRolling30Days: 100_000,
      concurrency: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 10,
    },
  };
  const lines = renderB3ApprovalPreviewV1(ready({ documentVersion: 1, kind: 'rule', rule: document })).terminal.split(
    '\n',
  );
  const line = lines.find((each) => each.startsWith(PLAIN_WORDS)) as string;
  assert.ok(line, lines.join('\n'));
  const sentence = line.slice(PLAIN_WORDS.length);
  // Every double quote outside an escape is the renderer's: the author's strings are exactly the literals between.
  const literals = [...sentence.matchAll(/"(?:[^"\\]|\\.)*"/gu)].map((match) => match[0]);
  assert.deepEqual(
    literals.map((literal) => JSON.parse(literal)),
    [forged, question],
    'each rule-author string is one literal, read back exactly',
  );
  // Outside the literals only the app's words remain: the forged sentence is not among them.
  const outside = sentence.replaceAll(/"(?:[^"\\]|\\.)*"/gu, '«…»');
  assert.equal(
    outside,
    'When mail arrives in ibx_RULESHOWRULESHW1 with «…» in the subject, ask Jev «…». If it says yes, send it to hooks.example.test.',
  );
  assert.doesNotMatch(outside, /Nothing leaves this Mac|Challenge/u);
  // No quote character a reader could take for the end of a quote survives inside a literal.
  for (const literal of literals) assert.doesNotMatch(literal.slice(1, -1), /['\u2018\u2019\u201c\u201d]|(?<!\\)"/u);
  assert.equal(lines.filter((each) => each.startsWith('Challenge ')).length, 1, 'only the real challenge line');
});
