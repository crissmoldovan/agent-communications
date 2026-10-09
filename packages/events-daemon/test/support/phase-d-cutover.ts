import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ApprovalStore, emptyConfig, type SecretStore } from '@agentcomms/core';
import type { ResendEventReader } from '@agentcomms/resend';
import type { SlackEventSource } from '@agentcomms/slack';
import type { WhatsAppEventOperations } from '@agentcomms/whatsapp';
import { ImmutableVersions } from '../../src/domain/versions.ts';
import {
  type ActivationDeadlineFailpoint,
  ActivationRuntime,
  type PreparedActivation,
} from '../../src/runtime/activations.ts';
import type { CutoverFailpoint } from '../../src/runtime/cutover-failpoint.ts';
import { DeliveryDispatcher, DryRunDispatcher } from '../../src/runtime/dispatcher.ts';
import { EventExpiry } from '../../src/runtime/expiry.ts';
import { EventLifecycle } from '../../src/runtime/lifecycle.ts';
import { createPhaseDWhatsAppOwnerComposition } from '../../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { disableRule, removeTarget } from '../../src/runtime/revocations.ts';
import { EventScheduler } from '../../src/runtime/scheduler.ts';
import { runSourceOwnerWork } from '../../src/runtime/source-owner-work.ts';
import type { SourceScope } from '../../src/sources/contracts.ts';
import { MailboxLock } from '../../src/sources/mailbox-lock.ts';
import { phaseDSourceRegistry } from '../../src/sources/registry.ts';
import { SourceScopeLock } from '../../src/sources/scope-lock.ts';
import { type EventDatabase, openEventDatabase } from '../../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../../src/store/event-secrets.ts';
import { EventRecordCipher } from '../../src/store/records.ts';
import { shortTempDir } from './short-temp.ts';

export type CutoverSource = 'slack' | 'resend' | 'whatsapp';

const retention = {
  ingestMs: 86_400_000,
  holdMs: 86_400_000,
  deliveryMs: 86_400_000,
  dryrunMs: 86_400_000,
  sseReplayMs: 86_400_000,
  deadLetterMs: 86_400_000,
  decisionMetadataMs: 86_400_000,
};

export const IDS = {
  slackTs: '1760000000.000000',
  resendId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  whatsappRawKey: '["wa-msg","chat-cutover","sender-cutover","stanza-cutover"]',
} as const;

type ScopedReplacementPlan = Readonly<{
  readonly oldOptions: unknown;
  readonly newOptions: unknown;
  readonly oldAccounts: readonly string[];
  readonly newAccounts: readonly string[];
}>;

const replacementAccounts = {
  old: 'acc_BBBBBBBBBBBBBBBB',
  shared: 'acc_CCCCCCCCCCCCCCCC',
  new: 'acc_DDDDDDDDDDDDDDDD',
} as const;

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly #values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.#values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.#values.delete(ref) ?? false;
  }
  invalidate(): void {}
}

/**
 * Production-driven cut-over fixture. It creates versions and approvals through
 * their public runtime APIs; tests only read SQLite tables, edit the core config,
 * write approvals, or reopen the same state directory.
 */
export class PhaseDCutoverFixture {
  readonly root: string;
  readonly stateDir: string;
  readonly configDir: string;
  readonly journalPath: string;
  readonly source: CutoverSource;
  readonly accountId: string;
  readonly scope: SourceScope;
  readonly config: ReturnType<typeof emptyConfig> = emptyConfig();
  readonly approvals: ApprovalStore;
  readonly secretStore: MemorySecretStore = new MemorySecretStore();
  readonly now = { value: 1_760_000_000_000 };
  readonly calls: string[] = [];
  baselineCalls = 0;
  pointEncryptions = 0;
  #store: EventDatabase;
  #cipher: EventRecordCipher | undefined;
  #runtime: ActivationRuntime | undefined;
  #lifecycle: EventLifecycle | undefined;
  #whatsapp: ReturnType<typeof createPhaseDWhatsAppOwnerComposition> | undefined;
  #failpoint: CutoverFailpoint | undefined;
  #deadlineFailpoint: ActivationDeadlineFailpoint | undefined;
  #slackPages: Pick<SlackEventSource, 'history' | 'replies'> | undefined;
  #resendSentStatus = 'sent';

  private constructor(input: {
    root: string;
    stateDir: string;
    configDir: string;
    source: CutoverSource;
    accountId: string;
    scope: SourceScope;
    store: EventDatabase;
  }) {
    this.root = input.root;
    this.stateDir = input.stateDir;
    this.configDir = input.configDir;
    this.journalPath = join(input.root, 'fake-provider-journal.ndjson');
    this.source = input.source;
    this.accountId = input.accountId;
    this.scope = input.scope;
    this.#store = input.store;
    this.config.accounts.cutover = { id: this.accountId, platform: this.source } as never;
    this.approvals = new ApprovalStore(join(input.root, 'approvals'), {
      now: () => new Date(this.now.value),
      loadConfig: async () => this.config,
    });
  }

  static async create(source: CutoverSource): Promise<PhaseDCutoverFixture> {
    const root = await shortTempDir(`events-${source}-cutover-`);
    const stateDir = join(root, 'state');
    const configDir = join(root, 'config');
    await mkdir(configDir, { recursive: true });
    // Event catalogue validation deliberately accepts only this account-id shape.
    const accountId = 'acc_ABCDEFGHIJKLMNOP';
    const scope =
      source === 'slack'
        ? { source, accountId, scopeId: `slack:${accountId}:C-cutover` }
        : source === 'resend'
          ? { source, accountId, scopeId: 'received' }
          : { source, accountId, scopeId: 'chat:chat-cutover' };
    const fixture = new PhaseDCutoverFixture({
      root,
      stateDir,
      configDir,
      source,
      accountId,
      scope,
      store: await openEventDatabase({ stateDir }),
    });
    await fixture.#openRuntime();
    return fixture;
  }

  get store(): EventDatabase {
    return this.#store;
  }

  get runtime(): ActivationRuntime {
    if (!this.#runtime) throw new Error('cut-over runtime is closed');
    return this.#runtime;
  }

  async setFailpoint(failpoint: CutoverFailpoint | undefined): Promise<void> {
    this.#failpoint = failpoint;
    await this.#openRuntime();
  }

  async setDeadlineFailpoint(failpoint: ActivationDeadlineFailpoint | undefined): Promise<void> {
    this.#deadlineFailpoint = failpoint;
    await this.#openRuntime();
  }

  /** Injected fake-only Slack pages for source-owner integration fixtures; no transport escapes this harness. */
  setSlackPages(pages: Pick<SlackEventSource, 'history' | 'replies'> | undefined): void {
    this.#slackPages = pages;
  }

  setResendSentStatus(status: string): void {
    this.#resendSentStatus = status;
  }

  async activate(
    version = 1,
    options: unknown = this.options(),
    mapping = 'safe',
    accountIds: readonly string[] = [this.accountId],
  ): Promise<void> {
    const versions = new ImmutableVersions(this.#store.database);
    if (version === 1)
      versions.createTarget({
        targetId: 'target-cutover',
        version: 1,
        kind: 'dry-run',
        retentionMs: retention.dryrunMs,
      });
    versions.createRule(this.rule(version, options, mapping, 60, accountIds));
    const prepared = await this.runtime.prepareRule({ ruleId: 'rule-cutover', version });
    if (!('approvalId' in prepared)) return;
    await this.#approve(prepared);
  }

  async enable(): Promise<void> {
    const prepared = await this.runtime.prepareEnableAll();
    await this.#approve(prepared);
  }

  async disableAll(): Promise<void> {
    if (!this.#lifecycle) throw new Error('cut-over runtime is closed');
    await this.#lifecycle.disableAll();
  }

  /** Complete a real exact replacement: the old source worker drains P, then recovery publishes v2. */
  async replace(): Promise<void> {
    // The scheduler owns the first-cursor/anchor installation.  Let its real
    // source turn establish that durable state before the replacement attempts
    // to drain its predecessor.
    await this.schedulerTurn();
    let waiting = false;
    try {
      await this.activate(2, this.options(), 'changed');
    } catch (error: unknown) {
      // Exact replacements intentionally remain claimed until their production
      // source drain certifies the old side of P.
      waiting = (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING';
      if (!waiting) throw error;
    }
    assert.equal(waiting, true, 'the production replacement waits for a source drain');
    await this.sourceTurn();
    await this.runtime.resumeClaimedCompletions();
  }

  async replaceWhileDisabled(): Promise<void> {
    await this.activate(2, this.options(), 'changed');
  }

  /**
   * Starts the real exact-replacement completion and deliberately keeps all
   * three scope relations durable.  Tests may only edit the core account
   * configuration; the activation runtime creates every baseline and drain.
   */
  async beginScopedReplacement(): Promise<void> {
    const plan = this.scopedReplacementPlan();
    for (const accountId of new Set([...plan.oldAccounts, ...plan.newAccounts])) {
      this.config.accounts[`scoped-${accountId}`] = { id: accountId, platform: this.source } as never;
    }
    await this.activate(1, plan.oldOptions, 'safe', plan.oldAccounts);
    await this.enable();
    let waiting = false;
    try {
      await this.activate(2, plan.newOptions, 'changed', plan.newAccounts);
    } catch (error: unknown) {
      waiting = (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING';
      if (!waiting) throw error;
    }
    assert.equal(waiting, true, 'the real replacement retains the old side until its source drain completes');
  }

  /** Reads the production replacement/baseline tables and proves every relation is distinct. */
  assertScopedReplacement(): void {
    const plan = this.scopedReplacementPlan();
    const registry = phaseDSourceRegistry().require(this.source);
    const scopes = (accountIds: readonly string[], options: unknown) =>
      accountIds.flatMap((accountId) => registry.scopesFor({ accountId, options: options as never }));
    const old = scopes(plan.oldAccounts, plan.oldOptions);
    const next = scopes(plan.newAccounts, plan.newOptions);
    const key = (scope: SourceScope) => `${scope.accountId}\u0000${scope.scopeId}`;
    const oldKeys = new Set(old.map(key));
    const newKeys = new Set(next.map(key));
    const oldOnly = old.filter((scope) => !newKeys.has(key(scope)));
    const newOnly = next.filter((scope) => !oldKeys.has(key(scope)));
    const shared = old.filter((scope) => newKeys.has(key(scope)));
    assert.ok(oldOnly.length > 0, 'the production plan drops at least one old-only source scope');
    assert.ok(newOnly.length > 0, 'the production plan adds at least one new-only source scope');
    assert.ok(shared.length > 0, 'the production plan retains at least one shared source scope');

    const drains = this.#store.database
      .prepare(
        `SELECT account_id, position_scope, old_in_scope, new_in_scope, drained_at
           FROM replacement_drains ORDER BY account_id, position_scope`,
      )
      .all() as Array<{
      account_id: string;
      position_scope: string;
      old_in_scope: number;
      new_in_scope: number;
      drained_at: number | null;
    }>;
    const drainByScope = new Map(drains.map((row) => [`${row.account_id}\u0000${row.position_scope}`, row]));
    const drainedAtP = (scope: SourceScope) =>
      this.source === 'resend' && scope.scopeId === 'status' ? this.now.value : null;
    for (const scope of oldOnly) {
      assert.deepEqual(
        { ...drainByScope.get(key(scope)) },
        {
          account_id: scope.accountId,
          position_scope: scope.scopeId,
          old_in_scope: 1,
          new_in_scope: 0,
          drained_at: drainedAtP(scope),
        },
      );
    }
    for (const scope of shared) {
      assert.deepEqual(
        { ...drainByScope.get(key(scope)) },
        {
          account_id: scope.accountId,
          position_scope: scope.scopeId,
          old_in_scope: 1,
          new_in_scope: 1,
          drained_at: drainedAtP(scope),
        },
      );
    }
    for (const scope of newOnly) {
      assert.equal(drainByScope.get(key(scope)), undefined, 'new-only scope never waits for an old source worker');
      assert.ok(
        this.#store.database
          .prepare(
            `SELECT 1 FROM activation_baselines
              WHERE source = ? AND account_id = ? AND position_scope = ?`,
          )
          .get(scope.source, scope.accountId, scope.scopeId),
        'new-only scope has its own durable P baseline',
      );
    }
    assert.equal(drains.length, old.length, 'only old-owned source scopes carry a replacement drain');
  }

  async tighten(): Promise<void> {
    const versions = new ImmutableVersions(this.#store.database);
    versions.createRule(this.rule(2, this.options(), 'safe', 30));
    const completion = await this.runtime.prepareRule({ ruleId: 'rule-cutover', version: 2 });
    assert.equal(
      'derived' in completion && completion.derived,
      true,
      'the production narrowing takes the derived path',
    );
  }

  async revokeByRule(): Promise<void> {
    await disableRule(this.#store, this.runtime, 'rule-cutover');
  }

  async revokeByTarget(): Promise<void> {
    await removeTarget(this.#store, this.runtime, 'target-cutover');
  }

  /** The same recovery entry point the scheduler invokes after an owner restart. */
  async recover(): Promise<void> {
    await this.runtime.recover();
  }

  removeAccount(): void {
    delete this.config.accounts.cutover;
  }

  readdAccount(): void {
    this.config.accounts.cutover = { id: this.accountId, platform: this.source } as never;
  }

  failedCompletions(): number {
    return Number(
      (
        this.#store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM activation_intents WHERE status = 'failed' AND failure_code = 'COMPLETION_TIMEOUT'",
          )
          .get() as { count: number }
      ).count,
    );
  }

  async schedulerTurn(): Promise<void> {
    if (!this.#lifecycle || !this.#cipher || !this.#whatsapp) throw new Error('cut-over runtime is closed');
    const dryrun = new DryRunDispatcher({
      store: this.#store,
      cipher: this.#cipher,
      approvals: this.approvals,
      config: { load: async () => this.config } as never,
      now: () => this.now.value,
    });
    // The cut-over matrix uses dry-run targets only; B2's router refuses any other target kind here.
    const refuse = {
      dispatch: async () => {
        throw new Error('the cut-over fixture has no network target');
      },
    };
    const dispatcher = new DeliveryDispatcher({ store: this.#store, dryrun, webhook: refuse, sse: refuse });
    const scheduler = new EventScheduler({
      store: this.#store,
      lifecycle: this.#lifecycle,
      activations: this.runtime,
      dispatcher,
      expiry: new EventExpiry(this.#store, () => this.now.value),
      cipher: this.#cipher,
      approvals: this.approvals,
      config: { load: async () => this.config } as never,
      taint: { record: async () => undefined } as never,
      gmailSourceFor: async () => {
        throw new Error('cut-over fixture never opens Gmail');
      },
      sourceWorkFor: async (scope) => {
        await this.sourceTurn(scope);
        return undefined;
      },
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      sourceRegistry: phaseDSourceRegistry(),
      whatsappVisibilityFence: this.#whatsapp.visibilityFence,
      pollIntervalMs: 1,
      now: () => this.now.value,
    });
    await scheduler.tick();
  }

  async sourceTurn(scope: SourceScope = this.scope): Promise<void> {
    if (!this.#cipher || !this.#lifecycle || !this.#whatsapp) throw new Error('cut-over runtime is closed');
    await runSourceOwnerWork(
      {
        store: this.#store,
        cipher: this.#cipher,
        approvals: this.approvals,
        config: { load: async () => this.config } as never,
        taint: { record: async () => undefined } as never,
        lifecycle: this.#lifecycle,
        sourceRegistry: phaseDSourceRegistry(),
        slackSourceFor: async () => this.slackReader(),
        resendReaderFor: async () => this.resendReader(),
        whatsappEventOperations: this.whatsappReader(),
        whatsappVisibilityFence: this.#whatsapp.visibilityFence,
        now: () => this.now.value,
        failpoint: this.#failpoint,
      },
      scope,
    );
  }

  async restart(): Promise<void> {
    this.#store.close();
    this.#store = await openEventDatabase({ stateDir: this.stateDir });
    this.#failpoint = undefined;
    this.#deadlineFailpoint = undefined;
    await this.#openRuntime();
  }

  async journal(): Promise<readonly string[]> {
    try {
      return (await readFile(this.journalPath, 'utf8')).trim().split('\n').filter(Boolean);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.#store.close();
    await rm(this.root, { recursive: true, force: true });
  }

  oracle(
    expected: Readonly<{
      raw: number;
      admissions: number;
      providerCalls?: number;
      versions?: readonly number[];
    }>,
  ): void {
    const database = this.#store.database;
    const raw = this.source === 'whatsapp' ? count(database, 'whatsapp_occurrences') : count(database, 'ingest');
    assert.equal(raw, expected.raw, 'the production raw ledger has the exact expected identity count');
    // A terminal EventEvaluator consumes its encrypted ingest_rules projection in
    // the same production transaction that creates its decision.  Decisions are
    // therefore the durable version-admission ledger after a completed turn.
    const admissions =
      this.source === 'whatsapp' ? count(database, 'whatsapp_rule_admissions') : count(database, 'decisions');
    assert.equal(
      admissions,
      expected.admissions,
      'the production version-admission ledger has the exact expected count',
    );
    if (expected.versions !== undefined) {
      const rows =
        this.source === 'whatsapp'
          ? (database
              .prepare('SELECT rule_version FROM whatsapp_rule_admissions ORDER BY rule_version')
              .all() as Array<{ rule_version: number }>)
          : (database.prepare('SELECT rule_version FROM decisions ORDER BY rule_version').all() as Array<{
              rule_version: number;
            }>);
      assert.deepEqual(
        rows.map((row) => row.rule_version),
        [...expected.versions].sort((left, right) => left - right),
        'each occurrence has the exact expected production rule-version multiset',
      );
    }
    if (expected.providerCalls !== undefined)
      assert.equal(
        this.calls.length,
        expected.providerCalls,
        'the fake provider journal has the exact expected call count',
      );
  }

  assertContentFreeSettlement(): void {
    const database = this.#store.database;
    assert.equal(count(database, 'ingest'), 0, 'deadline settlement retains no ingest content');
    assert.equal(count(database, 'ingest_rules'), 0, 'deadline settlement retains no projection content');
    assert.equal(count(database, 'source_scan_state'), 0, 'deadline settlement retains no staged source content');
    assert.equal(count(database, 'whatsapp_occurrences'), 0, 'deadline settlement retains no WhatsApp occurrence');
    assert.equal(count(database, 'whatsapp_rule_admissions'), 0, 'deadline settlement retains no WhatsApp admission');
  }

  options(): unknown {
    if (this.source === 'slack') return { channel: 'slack', conversations: ['C-cutover'] };
    if (this.source === 'resend') return { channel: 'resend', kinds: ['received'] };
    return { channel: 'whatsapp', chats: ['chat-cutover'] };
  }

  private rule(
    version: number,
    options: unknown,
    mapping: string,
    deliveryRateCap = 60,
    accountIds: readonly string[] = [this.accountId],
  ) {
    return {
      ruleId: 'rule-cutover',
      version,
      source: { channel: this.source, accountIds: [...accountIds].sort(), options },
      event: {
        type:
          this.source === 'slack'
            ? 'slack.message.posted'
            : this.source === 'resend'
              ? (options as { kinds?: readonly string[] }).kinds?.includes('status') === true &&
                !(options as { kinds?: readonly string[] }).kinds?.includes('received')
                ? 'resend.email.status_changed'
                : 'resend.email.received'
              : 'whatsapp.message.received',
        version: 1,
      },
      condition: { path: '/account/id', op: 'exists' },
      mapping: { constant: mapping },
      targets: [{ targetId: 'target-cutover', version: 1, kind: 'dry-run', retentionMs: retention.dryrunMs }],
      subscribers: [],
      judges: [],
      deliveryRateCap,
      retention,
    } as never;
  }

  private scopedReplacementPlan(): ScopedReplacementPlan {
    if (this.source === 'slack')
      return {
        oldOptions: { channel: 'slack', conversations: ['C-old', 'C-shared'] },
        newOptions: { channel: 'slack', conversations: ['C-new', 'C-shared'] },
        oldAccounts: [this.accountId],
        newAccounts: [this.accountId],
      };
    if (this.source === 'whatsapp')
      return {
        oldOptions: { channel: 'whatsapp', chats: ['chat-old', 'chat-shared'] },
        newOptions: { channel: 'whatsapp', chats: ['chat-new', 'chat-shared'] },
        oldAccounts: [this.accountId],
        newAccounts: [this.accountId],
      };
    // Resend has two source kinds, so the three relations use three distinct
    // configured accounts while exercising both received and status scopes.
    return {
      oldOptions: { channel: 'resend', kinds: ['received', 'status'] },
      newOptions: { channel: 'resend', kinds: ['received', 'status'] },
      oldAccounts: [replacementAccounts.old, replacementAccounts.shared],
      newAccounts: [replacementAccounts.new, replacementAccounts.shared],
    };
  }

  async #approve(prepared: PreparedActivation): Promise<void> {
    await this.runtime.approve({
      approvalId: prepared.approvalId,
      answer: await this.approvals.issueDisclosureChallenge(prepared.approvalId),
    });
  }

  async #openRuntime(): Promise<void> {
    await selectEventSecretStore(this.#store.database, 'file');
    const secrets = await openEventSecretStore({
      database: this.#store.database,
      paths: this.#store.paths,
      configDir: this.configDir,
      stores: { file: this.secretStore },
    });
    const cipher = new EventRecordCipher(this.#store.database, secrets);
    this.#cipher = cipher;
    this.#lifecycle = new EventLifecycle(this.#store, () => this.now.value);
    this.#whatsapp = createPhaseDWhatsAppOwnerComposition({
      database: this.#store,
      eventOperations: this.whatsappReader(),
    });
    this.#runtime = new ActivationRuntime({
      store: this.#store,
      approvals: this.approvals,
      config: { load: async () => this.config } as never,
      gmailSourceFor: async () => ({ getProfile: async () => ({ historyId: '1' }) }) as never,
      sourceRegistry: phaseDSourceRegistry(),
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      sourceBaselineFor: async (scope) => this.baseline(scope.source, scope.scopeId),
      encryptBaseline: async (intentId, accountId, value, scope) =>
        cipher.encrypt(
          activationBaselineLocation(intentId, scope?.source ?? 'gmail', accountId, scope?.scopeId ?? 'mailbox'),
          Buffer.from(JSON.stringify(value)),
        ),
      decryptBaseline: async (intentId, accountId, value, scope) =>
        JSON.parse(
          (
            await cipher.decrypt(
              activationBaselineLocation(intentId, scope?.source ?? 'gmail', accountId, scope?.scopeId ?? 'mailbox'),
              value,
            )
          ).toString('utf8'),
        ),
      encryptPoint: async ({ activationId, ruleId, ruleVersion, accountId, positionScope, position }) => {
        this.pointEncryptions += 1;
        return cipher.encrypt(
          activationPointLocation(activationId, ruleId, ruleVersion, accountId, positionScope),
          Buffer.from(JSON.stringify(position)),
        );
      },
      decryptPoint: async ({ activationId, ruleId, ruleVersion, accountId, positionScope, stored }) =>
        JSON.parse(
          (
            await cipher.decrypt(
              activationPointLocation(activationId, ruleId, ruleVersion, accountId, positionScope),
              stored,
            )
          ).toString('utf8'),
        ),
      now: () => this.now.value,
      failpoint: this.#failpoint,
      deadlineFailpoint: this.#deadlineFailpoint,
    });
  }

  private async baseline(source: CutoverSource | 'gmail', scope: string): Promise<unknown> {
    this.baselineCalls += 1;
    if (source === 'slack') return { timestamp: '1759999999.000000', replyDrain: { through: '1759999999.000000' } };
    if (source === 'resend')
      return scope === 'received' ? { anchorId: 'empty' } : { startedAt: new Date(this.now.value).toISOString() };
    return { capturedAt: new Date(this.now.value).toISOString(), baselineGeneration: 0, baselineIdentities: [] };
  }

  private async record(operation: string): Promise<void> {
    this.calls.push(operation);
    await appendFile(this.journalPath, `${operation}\n`, 'utf8');
  }

  private slackReader(): SlackEventSource {
    return {
      accountId: this.accountId,
      accountAlias: 'cutover',
      workspaceId: 'T-cutover',
      conversation: async () => ({ id: 'C-cutover', name: 'cutover', kind: 'private_channel' }),
      history: async (input) => {
        await this.record('slack.history');
        if (this.#slackPages !== undefined) return this.#slackPages.history(input);
        return {
          messages: [
            {
              ts: IDS.slackTs,
              threadTs: null,
              replyCount: 0,
              text: '<untrusted-content>cutover</untrusted-content>',
              author: { name: null, app: false, external: false },
              truncated: false,
              mismatch: false,
              unrenderable: false,
              editedTs: null,
              mentions: [],
              files: [],
            },
          ],
          nextCursor: null,
          retainedHistoryBoundary: false,
        };
      },
      replies: async (input) => {
        await this.record('slack.replies');
        if (this.#slackPages !== undefined) return this.#slackPages.replies(input);
        return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
      },
    } as SlackEventSource;
  }

  private resendReader(): ResendEventReader {
    return {
      listReceived: async () => {
        await this.record('resend.listReceived');
        return { emails: [{ id: IDS.resendId }], next: null };
      },
      getReceived: async () => {
        await this.record('resend.getReceived');
        return {
          kind: 'candidate',
          candidate: {
            emailId: IDS.resendId,
            receivedAt: '2026-10-09T12:00:00.000Z',
            subject: 'cutover',
            attachments: [],
            attachmentCount: 0,
            from: null,
            replyTo: [],
            to: [],
            cc: [],
            receivedFor: [],
            messageId: null,
            authentication: { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
          },
        };
      },
      listSent: async () => {
        await this.record('resend.listSent');
        return {
          emails: [
            {
              id: IDS.resendId,
              lastEvent: this.#resendSentStatus,
              from: null,
              to: [],
              cc: [],
              bcc: [],
              subject: 'cutover status',
              createdAt: '2026-10-09T12:00:00.000Z',
              scheduledAt: null,
              messageId: null,
            },
          ],
          next: null,
        };
      },
    };
  }

  private whatsappReader(): WhatsAppEventOperations {
    const visibility = {
      version: 1 as const,
      digest: createHash('sha256').update('cutover').digest('hex'),
      seesMessage: () => true,
    };
    return {
      withCurrentEventVisibility: async (_input, work) => work(visibility),
      withEventSnapshot: async (_input, work) => {
        await this.record('whatsapp.snapshot');
        return work({
          accountId: this.accountId,
          accountName: 'cutover',
          visibility,
          messages: [
            {
              sourceOrder: 1,
              chatJid: 'chat-cutover',
              chatKind: 'group',
              senderJidRaw: 'sender-cutover',
              stanzaId: 'stanza-cutover',
              fromMe: false,
              at: '2026-10-09T12:00:00.000Z',
              kind: 'text',
              body: 'cutover',
            },
          ],
        });
      },
    };
  }
}

function count(database: EventDatabase['database'], table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function activationBaselineLocation(intentId: string, source: string, accountId: string, scopeId: string) {
  return {
    table: 'activation_baselines',
    column: 'encryptedPosition',
    key: [
      { type: 'text' as const, value: intentId },
      { type: 'text' as const, value: source },
      { type: 'text' as const, value: accountId },
      { type: 'text' as const, value: scopeId },
    ],
  };
}

function activationPointLocation(
  activationId: string,
  ruleId: string,
  ruleVersion: number,
  accountId: string,
  scopeId: string,
) {
  return {
    table: 'rule_activation_points',
    column: 'encryptedPosition',
    key: [
      { type: 'text' as const, value: activationId },
      { type: 'text' as const, value: ruleId },
      { type: 'integer' as const, value: ruleVersion },
      { type: 'text' as const, value: accountId },
      { type: 'text' as const, value: scopeId },
    ],
  };
}
