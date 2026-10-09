import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-1', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const judge = { judgeId: 'judge-1', version: 1, kind: 'typesafe' as const, provider: 'local', model: 'fixture' };
const deterministicRule = {
  ruleId: 'rule-1',
  version: 1,
  source: {
    channel: 'gmail' as const,
    accountIds: ['account-1'],
    options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { constant: 'safe' },
  targets: [target],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: {
    ingestMs: 604_800_000,
    holdMs: 604_800_000,
    deliveryMs: 604_800_000,
    dryrunMs: 86_400_000,
    sseReplayMs: 604_800_000,
    deadLetterMs: 604_800_000,
    decisionMetadataMs: 7_776_000_000,
  },
};

test('APR/JDG-B1: immutable target, subscriber and judge versions are inert, while deterministic rules can prepare', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-vl-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const versions = new ImmutableVersions(store.database);
      versions.createTarget(target);
      versions.createSubscriber({
        subscriberId: 'subscriber-1',
        version: 1,
        kind: 'sse',
        authority: { host: '127.0.0.1', port: 9443 },
        origins: ['https://app.example.test'],
        retentionMs: 604_800_000,
      });
      versions.createJudge(judge);
      const prepared = versions.createRule(deterministicRule);
      assert.equal(prepared.state, null);
      assert.equal(versions.activeVersion('rule', 'rule-1'), null, 'persisting a pending rule cannot activate it');
      assert.equal(versions.activeVersion('judge-kind', 'typesafe'), null, 'every judge kind begins disabled');
      assert.equal(versions.prepareRule('rule-1', 1).kind, 'rule');
      const inert = store.database
        .prepare("SELECT COUNT(*) AS count FROM active_versions WHERE kind IN ('rule', 'judge-kind')")
        .get() as { count: number };
      assert.equal(inert.count, 0, 'object creation never creates a standalone activation');
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('JDG-B1: a rule that references a disabled judge kind is refused with its stable code', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-vl-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const versions = new ImmutableVersions(store.database);
      versions.createTarget(target);
      versions.createJudge(judge);
      versions.createRule({
        ...deterministicRule,
        ruleId: 'rule-judge',
        judges: [judge],
      });
      assert.throws(
        () => versions.prepareRule('rule-judge', 1),
        (error: unknown) => error instanceof EventDomainError && error.code === 'JUDGE_KIND_DISABLED',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('APR-B1: persisted full rules use the catalogue to canonicalise conditions and validate mappings', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-vl-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const versions = new ImmutableVersions(store.database);
      versions.createTarget(target);
      const pending = versions.createRule({
        ...deterministicRule,
        ruleId: 'rule-canonical',
        condition: { path: '/subject', op: 'contains', value: 'review' },
        mapping: { subject: { $path: '/subject' } },
      });
      assert.deepEqual((pending.document.condition as Record<string, unknown>).caseSensitive, false);
      assert.throws(
        () =>
          versions.createRule({
            ...deterministicRule,
            ruleId: 'rule-invalid-mapping',
            mapping: { missing: { $path: '/no-such-field' } },
          }),
        (error: unknown) => error instanceof EventDomainError && error.code === 'VERSION_DOCUMENT_INVALID',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('CAT-B1: operational types and fixed test/reset controls cannot be persisted as selectable rule types', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-vl-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const versions = new ImmutableVersions(store.database);
      for (const type of [
        'agentcomms.source.gap',
        'agentcomms.any-future-operation',
        'io.agentcomms.test.v1',
        'io.agentcomms.control.installation-reset.v1',
      ]) {
        assert.throws(
          () => versions.createRule({ ...deterministicRule, ruleId: `rule-${type}`, event: { type, version: 1 } }),
          (error: unknown) => error instanceof EventDomainError && error.code === 'EVENT_TYPE_NOT_SELECTABLE',
          type,
        );
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('APR-B1: a rule embeds stored immutable versions byte for byte, or it is refused', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-vl-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const versions = new ImmutableVersions(store.database);
      const refusedAs = (pattern: RegExp) => (error: unknown) =>
        error instanceof EventDomainError && error.code === 'VERSION_DOCUMENT_INVALID' && pattern.test(error.message);
      assert.throws(() => versions.createRule(deterministicRule), refusedAs(/not a stored version/));
      versions.createTarget(target);
      // The same id and version, but a different retention than the stored target: the approval would show one and
      // the delivery use the other.
      assert.throws(
        () => versions.createRule({ ...deterministicRule, targets: [{ ...target, retentionMs: 3_600_000 }] }),
        refusedAs(/differs from the stored version/),
      );
      assert.throws(
        () => versions.createRule({ ...deterministicRule, ruleId: 'rule-j', judges: [judge] }),
        refusedAs(/judge-1 version 1, which is not a stored version/),
      );
      versions.createJudge(judge);
      assert.throws(
        () =>
          versions.createRule({
            ...deterministicRule,
            ruleId: 'rule-j',
            judges: [{ ...judge, model: 'another-model' }],
          }),
        refusedAs(/differs from the stored version/),
      );
      assert.equal(versions.createRule(deterministicRule).state, null);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
