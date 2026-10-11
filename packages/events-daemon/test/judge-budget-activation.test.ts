import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, emptyConfig } from '@agentcomms/core';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime } from '../src/runtime/activations.ts';
import { JudgeBudgetActivation } from '../src/runtime/judge-budget-activation.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const budget = {
  budgetId: 'judge-budget' as const,
  version: 1,
  global: { callsPerRollingHour: 11, inputTokensPerRolling30Days: 1_100, concurrency: 2 },
  providers: [{ provider: 'typesafe', callsPerRollingHour: 7, inputTokensPerRolling30Days: 700, concurrency: 1 }],
};

async function fixture(
  options: {
    readonly beforeFinalise?: (() => void) | undefined;
    readonly afterCoreClaim?: (() => void) | undefined;
  } = {},
) {
  const root = await shortTempDir('events-e4-budget-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(emptyConfig())}\n`);
  const store = await openEventDatabase({ stateDir });
  const config = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => config.load() });
  new ImmutableVersions(store.database).createJudgeBudget(budget);
  let providerCalls = 0;
  const approvalBridge = {
    createDisclosure: approvals.createDisclosure.bind(approvals),
    approveDisclosure: approvals.approveDisclosure.bind(approvals),
    claimForDisclosure: async (...args: Parameters<typeof approvals.claimForDisclosure>) => {
      const claimed = await approvals.claimForDisclosure(...args);
      options.afterCoreClaim?.();
      return claimed;
    },
    get: approvals.get.bind(approvals),
    issueDisclosureChallenge: approvals.issueDisclosureChallenge.bind(approvals),
    list: approvals.list.bind(approvals),
  };
  const runtime = new ActivationRuntime({
    store,
    approvals: approvalBridge,
    config,
    gmailSourceFor: async () => ({
      getProfile: async () => {
        providerCalls += 1;
        return { emailAddress: 'never-called@example.test', messagesTotal: 0, threadsTotal: 0, historyId: '1' };
      },
    }),
    encryptBaseline: async () => Buffer.alloc(0),
    decryptBaseline: async () => ({}),
    encryptPoint: async () => Buffer.alloc(0),
    decryptPoint: async () => ({}),
    mailboxLock: new MailboxLock(),
    failpoint: (edge) => {
      if (edge === 'before-finalise') options.beforeFinalise?.();
    },
  });
  return {
    root,
    store,
    approvals,
    runtime,
    budgetActivation: new JudgeBudgetActivation({ activations: runtime }),
    providerCalls: () => providerCalls,
  };
}

async function approveBudget(setup: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await setup.budgetActivation.prepare({ version: budget.version });
  const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
  await setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge });
  return prepared;
}

const typesafeKind = {
  id: 'judge-kind:typesafe' as const,
  kind: 'typesafe' as const,
  version: 1,
  endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
};

type DigestSubject = 'judge-budget' | 'judge-kind';

function installDigestSubject(setup: Awaited<ReturnType<typeof fixture>>, subject: DigestSubject): void {
  if (subject === 'judge-kind') new ImmutableVersions(setup.store.database).createJudgeKind(typesafeKind);
}

function corruptStoredDocument(setup: Awaited<ReturnType<typeof fixture>>, subject: DigestSubject): void {
  if (subject === 'judge-budget') {
    setup.store.database
      .prepare('UPDATE judge_budget_versions SET document = replace(document, ?, ?) WHERE version = 1')
      .run('"concurrency":2', '"concurrency":3');
  } else {
    setup.store.database
      .prepare('UPDATE judge_kind_versions SET document = replace(document, ?, ?) WHERE kind = ? AND version = 1')
      .run('"version":1', '"version":2', 'typesafe');
  }
}

function corruptStoredDigest(setup: Awaited<ReturnType<typeof fixture>>, subject: DigestSubject): void {
  const table = subject === 'judge-budget' ? 'judge_budget_versions' : 'judge_kind_versions';
  const where = subject === 'judge-budget' ? 'version = 1' : "kind = 'typesafe' AND version = 1";
  setup.store.database.prepare(`UPDATE ${table} SET digest = ? WHERE ${where}`).run('0'.repeat(64));
}

async function prepareDigestSubject(setup: Awaited<ReturnType<typeof fixture>>, subject: DigestSubject) {
  return subject === 'judge-budget'
    ? setup.runtime.prepareJudgeBudget({ version: 1 })
    : setup.runtime.prepareJudgeKind({ kind: 'typesafe', version: 1 });
}

function digestPointer(setup: Awaited<ReturnType<typeof fixture>>, subject: DigestSubject) {
  return new ImmutableVersions(setup.store.database).activeVersion(
    subject,
    subject === 'judge-budget' ? 'judge-budget' : 'typesafe',
  );
}

test('E4 activation digest fence: prepare rejects altered budget and kind version documents', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const subject of ['judge-budget', 'judge-kind'] as const) {
    const setup = await fixture();
    try {
      installDigestSubject(setup, subject);
      corruptStoredDocument(setup, subject);
      await assert.rejects(
        () => prepareDigestSubject(setup, subject),
        (error: unknown) => error instanceof EventDomainError && error.code === 'VERSION_DOCUMENT_INVALID',
        `${subject}: preparation must refuse the stored-document/digest drift`,
      );
      assert.equal(digestPointer(setup, subject), null, `${subject}: preparation wrote no pointer`);
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test('E4 activation digest fence: the production kind loader rejects a valid altered document with its original digest', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    installDigestSubject(setup, 'judge-kind');
    corruptStoredDocument(setup, 'judge-kind');
    assert.throws(
      () => new ImmutableVersions(setup.store.database).prepareJudgeKind('typesafe', 1),
      (error: unknown) => error instanceof EventDomainError && error.code === 'VERSION_DOCUMENT_INVALID',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 activation digest fence: claim rejects a budget or kind digest changed after approval', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const subject of ['judge-budget', 'judge-kind'] as const) {
    let corrupt: (() => void) | undefined;
    const setup = await fixture({ afterCoreClaim: () => corrupt?.() });
    try {
      installDigestSubject(setup, subject);
      const prepared = await prepareDigestSubject(setup, subject);
      const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
      corrupt = () => corruptStoredDigest(setup, subject);
      await assert.rejects(
        () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
        /document|digest|void|changed/iu,
        `${subject}: the post-await claim transaction must refuse digest drift`,
      );
      assert.equal(digestPointer(setup, subject), null, `${subject}: claim drift wrote no pointer`);
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test('E4 activation digest fence: finalise rejects a budget or kind digest changed after claim', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const subject of ['judge-budget', 'judge-kind'] as const) {
    let corrupt: (() => void) | undefined;
    const setup = await fixture({ beforeFinalise: () => corrupt?.() });
    try {
      installDigestSubject(setup, subject);
      const prepared = await prepareDigestSubject(setup, subject);
      const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
      corrupt = () => corruptStoredDigest(setup, subject);
      await assert.rejects(
        () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
        /document|digest|void|changed/iu,
        `${subject}: the final pointer transaction must refuse digest drift`,
      );
      assert.equal(digestPointer(setup, subject), null, `${subject}: finalise drift wrote no pointer`);
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test('E4 judge kind: disable before first enablement cancels the pending activation and reports its absent pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    new ImmutableVersions(setup.store.database).createJudgeKind(typesafeKind);
    const prepared = await setup.runtime.prepareJudgeKind({ kind: 'typesafe', version: 1 });
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    assert.deepEqual(
      new JudgeKinds({ store: setup.store, now: () => 1, activations: setup.runtime }).disable('typesafe'),
      { kind: 'typesafe', disabled: true, pointer: 'absent', pendingActivationsCancelled: 1 },
    );
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      (error: unknown) =>
        (error instanceof EventDomainError && error.code === 'JUDGE_KIND_DISABLED') ||
        (error instanceof Error && /cancelled|void/iu.test(error.message)),
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT status FROM activation_intents WHERE id = ?').get(prepared.intentId) as {
          status: string;
        }
      ).status,
      'cancelled',
      'the disable transaction still settles the already-persisted initial enablement',
    );
    assert.equal(digestPointer(setup, 'judge-kind'), null, 'the cancelled intent cannot install its first pointer');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 judge kind: an absent-kind disable during prepare refuses before it can install a first pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    new ImmutableVersions(setup.store.database).createJudgeKind(typesafeKind);
    const preparing = setup.runtime.prepareJudgeKind({ kind: 'typesafe', version: 1 });
    const disabled = new JudgeKinds({ store: setup.store, now: () => 1, activations: setup.runtime }).disable(
      'typesafe',
    );
    assert.deepEqual(disabled, {
      kind: 'typesafe',
      disabled: true,
      pointer: 'absent',
      pendingActivationsCancelled: 0,
    });

    const outcome = await preparing.then(
      (prepared) => ({ prepared }),
      (error: unknown) => ({ error }),
    );
    if ('prepared' in outcome) {
      const challenge = await setup.runtime.issueChallenge(outcome.prepared.approvalId);
      await setup.runtime.approve({ approvalId: outcome.prepared.approvalId, answer: challenge });
      assert.equal(
        digestPointer(setup, 'judge-kind'),
        null,
        'a prepare that began before disable cannot approve a new first pointer after disable wins',
      );
      return;
    }

    assert.ok(outcome.error instanceof EventDomainError && outcome.error.code === 'JUDGE_KIND_DISABLED');
    assert.equal(
      (
        setup.store.database
          .prepare("SELECT COUNT(*) AS count FROM activation_intents WHERE kind = 'judge-kind'")
          .get() as { count: number }
      ).count,
      0,
      'the durable disable fence refuses before an intent exists',
    );
    assert.equal(digestPointer(setup, 'judge-kind'), null);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 judge-budget activation: an approved immutable singleton is the only path that swaps its exact pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const prepared = await approveBudget(setup);
    assert.deepEqual(new ImmutableVersions(setup.store.database).activeVersion('judge-budget', 'judge-budget'), {
      version: 1,
      currentCutoverId: null,
    });
    assert.equal(setup.providerCalls(), 0, 'budget approval has no provider boundary');
    const intent = setup.store.database
      .prepare('SELECT kind, status, digest FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as { kind: string; status: string; digest: string };
    assert.deepEqual(
      { kind: intent.kind, status: intent.status, digest: intent.digest },
      {
        kind: 'judge-budget',
        status: 'completed',
        digest: prepared.binding.digest,
      },
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 judge-budget activation: the final write rejects pointer drift after the core claim', {
  skip: WINDOWS_SKIP,
}, async () => {
  let drift: (() => void) | undefined;
  const setup = await fixture({ beforeFinalise: () => drift?.() });
  drift = () =>
    setup.store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, NULL, 1)",
      )
      .run();
  try {
    const prepared = await setup.runtime.prepareJudgeBudget({ version: 1 });
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      /changed|void/u,
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT status FROM activation_intents WHERE id = ?').get(prepared.intentId) as {
          status: string;
        }
      ).status,
      'cancelled',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 judge-budget activation: the local claim transaction rejects post-await pointer drift before finalisation', {
  skip: WINDOWS_SKIP,
}, async () => {
  let drift: (() => void) | undefined;
  let finaliseCalls = 0;
  const setup = await fixture({
    afterCoreClaim: () => drift?.(),
    beforeFinalise: () => {
      finaliseCalls += 1;
    },
  });
  drift = () =>
    setup.store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, NULL, 1)",
      )
      .run();
  try {
    const prepared = await setup.budgetActivation.prepare({ version: 1 });
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      /changed|void/u,
    );
    assert.equal(finaliseCalls, 0, 'the local claimed-work transaction catches drift before finalisation');
    assert.equal(
      (
        setup.store.database.prepare('SELECT status FROM activation_intents WHERE id = ?').get(prepared.intentId) as {
          status: string;
        }
      ).status,
      'cancelled',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 judge-budget activation: claim rejects a stale pointer and immutable digest before core can spend approval', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const pointer = await setup.runtime.prepareJudgeBudget({ version: 1 });
    const pointerChallenge = await setup.runtime.issueChallenge(pointer.approvalId);
    setup.store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, NULL, 1)",
      )
      .run();
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: pointer.approvalId, answer: pointerChallenge }),
      /pointer|void/u,
    );
    const approval = await setup.approvals.get(pointer.approvalId);
    assert.equal(approval?.form === 'v2' ? approval.record.state : undefined, 'pending');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
  const digest = await fixture();
  try {
    const prepared = await digest.runtime.prepareJudgeBudget({ version: 1 });
    digest.store.database
      .prepare('UPDATE judge_budget_versions SET document = replace(document, ?, ?) WHERE version = 1')
      .run('"concurrency":2', '"concurrency":3');
    await assert.rejects(() => digest.runtime.issueChallenge(prepared.approvalId), /document|void/u);
  } finally {
    digest.store.close();
    await rm(digest.root, { recursive: true, force: true });
  }
});

test('E4 judge kind: TypeSafe enablement has no request, while Laya refuses before an intent or pointer exists', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    new ImmutableVersions(setup.store.database).createJudgeKind({
      id: 'judge-kind:typesafe',
      kind: 'typesafe',
      version: 1,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
    });
    const prepared = await setup.runtime.prepareJudgeKind({ kind: 'typesafe', version: 1 });
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    await setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge });
    assert.equal(new ImmutableVersions(setup.store.database).activeVersion('judge-kind', 'typesafe')?.version, 1);
    assert.equal(setup.providerCalls(), 0, 'kind enablement has no provider request');
    await assert.rejects(
      () => setup.runtime.prepareJudgeKind({ kind: 'laya', version: 1 }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'E2_REQUIRED',
    );
    assert.equal(
      (
        setup.store.database
          .prepare("SELECT COUNT(*) AS count FROM activation_intents WHERE kind = 'judge-kind'")
          .get() as { count: number }
      ).count,
      1,
      'the refused Laya request creates no intent',
    );
    assert.equal(new ImmutableVersions(setup.store.database).activeVersion('judge-kind', 'laya'), null);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});
