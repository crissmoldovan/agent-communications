import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type SecretStore, sha256Hex } from '@agentcomms/core';
import type { HumanSecret } from '../domain/human-secret.ts';
import { JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import { canonicalWebhookSubscriber } from '../domain/webhook-subscriber.ts';
import { canonicalWebhookTarget, secretWebhookUrlDescriptor } from '../domain/webhook-target.ts';
import {
  EVENT_SECRET_PROVIDERS,
  type EventSecretMigrationResult,
  type EventSecretOwner,
  type EventSecretProvider,
  type EventSecretPurpose,
  type EventSecretStore,
  type EventSecretStoreKind,
  migrateEventSecrets,
  providerSecretOwner,
} from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';
import type { EventPaths } from './paths.ts';
import type { SubscriberStreams } from './subscriber-streams.ts';
import { type WriterQuiescer, withEventWriterLease } from './writer-quiescer.ts';

interface ExactOwner extends EventSecretOwner {}

export type SecretReceipt =
  | { readonly kind: 'target-secret'; readonly targetId: string; readonly version: number; readonly generation: number }
  | {
      readonly kind: 'subscriber-token';
      readonly subscriberId: string;
      readonly version: number;
      readonly generation: number;
    }
  | {
      readonly kind: 'subscriber-secret';
      readonly subscriberId: string;
      readonly version: number;
      readonly generation: number;
    }
  | { readonly kind: 'judge-key'; readonly judgeId: string; readonly version: number; readonly generation: number };

/** What a provider key operation did: never the key, nor any part of it (owner decision 2026-10-26). */
export interface ProviderKeyReceipt {
  readonly provider: EventSecretProvider;
  readonly hasKey: boolean;
  /** How many live Jev judge versions of this provider now hold this key, or, after a removal, hold none. */
  readonly judges: number;
}

/** A live Jev judge version, and the provider that serves it (a document from before 2026-10-26 names no provider: TypeSafe serves it). */
interface HostedJudgeVersion {
  readonly judgeId: string;
  readonly version: number;
  readonly provider: string;
}

/**
 * A generated credential has no JSON representation until the terminal owner consumes it.  Keeping the material on a
 * non-enumerable symbol lets the durable engine continue to return receipt-shaped values to audit/log/result code;
 * only `consumeGeneratedTerminalReveal` can turn it into the transient terminal control reply.
 */
const GENERATED_TERMINAL_REVEAL = Symbol('generated-terminal-reveal');
type GeneratedSecretReceipt = SecretReceipt & { [GENERATED_TERMINAL_REVEAL]?: string };

function generatedReceipt(receipt: SecretReceipt, material: string): SecretReceipt {
  Object.defineProperty(receipt, GENERATED_TERMINAL_REVEAL, {
    configurable: true,
    enumerable: false,
    value: material,
    writable: false,
  });
  return receipt;
}

/** Consumes a generated credential exactly once at the controlling terminal boundary. */
export function consumeGeneratedTerminalReveal(receipt: SecretReceipt): string | null {
  const generated = receipt as GeneratedSecretReceipt;
  const material = generated[GENERATED_TERMINAL_REVEAL];
  if (material === undefined) return null;
  delete generated[GENERATED_TERMINAL_REVEAL];
  return material;
}

function currentGeneration(database: DatabaseSync, owner: ExactOwner, purpose: EventSecretPurpose): number | null {
  const row = database
    .prepare(
      `SELECT generation FROM event_secret_generations
       WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? AND lifecycle = 'current'`,
    )
    .get(owner.kind, owner.id, owner.version, purpose) as { generation: number } | undefined;
  return row?.generation ?? null;
}

function exactOwner(database: DatabaseSync, kind: ExactOwner['kind'], id: string, version: number): ExactOwner {
  const table =
    kind === 'target' ? 'target_versions' : kind === 'subscriber' ? 'subscriber_versions' : 'judge_versions';
  const idColumn = kind === 'target' ? 'target_id' : kind === 'subscriber' ? 'subscriber_id' : 'judge_id';
  const row = database
    .prepare(`SELECT digest, revoked_at FROM ${table} WHERE ${idColumn} = ? AND version = ?`)
    .get(id, version) as { digest: string; revoked_at: number | null } | undefined;
  if (row === undefined || row.revoked_at !== null) throw new Error('the exact immutable secret owner is not live');
  return { kind, id, version, digest: row.digest };
}

/**
 * Owner-side B3 secret state engine. This never renders material: callers get
 * a receipt and the later terminal-only layer owns any one-time reveal.
 */
export class B3SecretControl {
  readonly #database: DatabaseSync;
  readonly #paths: EventPaths;
  readonly #secrets: EventSecretStore;
  readonly #cipher: EventRecordCipher;
  readonly #quiescer: WriterQuiescer;
  readonly #subscriberStreams: Pick<SubscriberStreams, 'rotate'> | undefined;
  /** Test-only deterministic material seam; production always uses fresh random material below. */
  readonly #secretMaterial: Readonly<{ nextSigningSecret(): string; nextSubscriberToken(): string }> | undefined;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly paths: EventPaths;
    readonly secrets: EventSecretStore;
    readonly cipher: EventRecordCipher;
    readonly quiescer: WriterQuiescer;
    readonly subscriberStreams?: Pick<SubscriberStreams, 'rotate'> | undefined;
    readonly secretMaterial?: Readonly<{ nextSigningSecret(): string; nextSubscriberToken(): string }> | undefined;
  }) {
    this.#database = input.database;
    this.#paths = input.paths;
    this.#secrets = input.secrets;
    this.#cipher = input.cipher;
    this.#quiescer = input.quiescer;
    if (input.cipher.writerQuiescer !== input.quiescer)
      throw new Error('B3 secret control and record cipher must use the same owner writer quiescer');
    this.#subscriberStreams = input.subscriberStreams;
    this.#secretMaterial = input.secretMaterial;
  }

  async targetSecretCreate(input: { readonly targetId: string; readonly version: number }): Promise<SecretReceipt> {
    return withEventWriterLease(this.#quiescer, async () => {
      const owner = exactOwner(this.#database, 'target', input.targetId, input.version);
      const material = this.#newSigningSecret();
      const generation = await this.#store(owner, 'webhook-signing', material, null, false, true);
      return generatedReceipt(
        { kind: 'target-secret', targetId: input.targetId, version: input.version, generation },
        material,
      );
    });
  }

  async targetSecretRotate(input: { readonly targetId: string; readonly version: number }): Promise<SecretReceipt> {
    return this.#quiescer.withExclusive(async () => {
      const owner = exactOwner(this.#database, 'target', input.targetId, input.version);
      const prior = this.#requiredCurrent(owner, 'webhook-signing');
      const retired = await this.#secrets.currentMaster();
      await this.#cipher.rotateAndReencrypt();
      const material = this.#newSigningSecret();
      const generation = await this.#store(owner, 'webhook-signing', material, prior, false);
      await this.#secrets.destroyRetiredMaster({
        keyId: retired.keyId,
        cipher: this.#cipher,
        quiescer: this.#quiescer,
      });
      return generatedReceipt(
        { kind: 'target-secret', targetId: input.targetId, version: input.version, generation },
        material,
      );
    });
  }

  async subscriberTokenCreate(input: {
    readonly subscriberId: string;
    readonly version: number;
  }): Promise<SecretReceipt> {
    return withEventWriterLease(this.#quiescer, async () => {
      const owner = exactOwner(this.#database, 'subscriber', input.subscriberId, input.version);
      const material = this.#newToken();
      const generation = await this.#store(owner, 'sse-bearer', material, null, false, true);
      return generatedReceipt(
        { kind: 'subscriber-token', subscriberId: input.subscriberId, version: input.version, generation },
        material,
      );
    });
  }

  async subscriberTokenRotate(input: {
    readonly subscriberId: string;
    readonly version: number;
  }): Promise<SecretReceipt> {
    return this.#quiescer.withExclusive(async () => {
      const owner = exactOwner(this.#database, 'subscriber', input.subscriberId, input.version);
      const prior = this.#requiredCurrent(owner, 'sse-bearer');
      const retired = await this.#secrets.currentMaster();
      await this.#cipher.rotateAndReencrypt();
      const material = this.#newToken();
      const generation = await this.#store(owner, 'sse-bearer', material, prior, true);
      this.#subscriberStreams?.rotate({
        subscriberId: input.subscriberId,
        subscriberVersion: input.version,
        generation,
      });
      await this.#secrets.reconcileRetiredGenerations(this.#cipher);
      await this.#secrets.destroyRetiredMaster({
        keyId: retired.keyId,
        cipher: this.#cipher,
        quiescer: this.#quiescer,
      });
      return generatedReceipt(
        { kind: 'subscriber-token', subscriberId: input.subscriberId, version: input.version, generation },
        material,
      );
    });
  }

  /**
   * A webhook subscriber version's signing secret (0.36.0, W29, W32), generated here and revealed once at the terminal,
   * as a webhook target's is. Only a live webhook subscriber version has the slot.
   */
  async subscriberSecretCreate(input: {
    readonly subscriberId: string;
    readonly version: number;
  }): Promise<SecretReceipt> {
    return withEventWriterLease(this.#quiescer, async () => {
      const owner = this.#webhookSubscriber(input.subscriberId, input.version);
      const material = this.#newSigningSecret();
      const generation = await this.#store(owner, 'webhook-signing', material, null, false, true);
      return generatedReceipt(
        { kind: 'subscriber-secret', subscriberId: input.subscriberId, version: input.version, generation },
        material,
      );
    });
  }

  /** Rotates it, as a webhook target's is: the previous secret keeps signing beside the new one through its overlap. */
  async subscriberSecretRotate(input: {
    readonly subscriberId: string;
    readonly version: number;
  }): Promise<SecretReceipt> {
    return this.#quiescer.withExclusive(async () => {
      const owner = this.#webhookSubscriber(input.subscriberId, input.version);
      const prior = this.#requiredCurrent(owner, 'webhook-signing');
      const retired = await this.#secrets.currentMaster();
      await this.#cipher.rotateAndReencrypt();
      const material = this.#newSigningSecret();
      const generation = await this.#store(owner, 'webhook-signing', material, prior, false);
      await this.#secrets.destroyRetiredMaster({
        keyId: retired.keyId,
        cipher: this.#cipher,
        quiescer: this.#quiescer,
      });
      return generatedReceipt(
        { kind: 'subscriber-secret', subscriberId: input.subscriberId, version: input.version, generation },
        material,
      );
    });
  }

  /**
   * A webhook subscriber's secret URL (0.36.0, W29): a new immutable version `version`, made from the newest earlier
   * version with the hidden URL's public descriptor in place of its URL, and its complete URL kept only in the secret
   * store, in one commit. The new version is inert until the person approves its events.
   */
  async subscriberUrlSet(input: {
    readonly subscriberId: string;
    readonly version: number;
    readonly hiddenUrl: string;
  }): Promise<{ readonly scheme: string; readonly host: string; readonly port: number; readonly sha256: string }> {
    return withEventWriterLease(this.#quiescer, async () => {
      if (!Number.isSafeInteger(input.version) || input.version < 1)
        throw new Error('the new subscriber version is a positive integer');
      const row = this.#database
        .prepare(
          'SELECT document FROM subscriber_versions WHERE subscriber_id = ? AND version < ? ORDER BY version DESC LIMIT 1',
        )
        .get(input.subscriberId, input.version) as { document: string } | undefined;
      if (row === undefined) throw new Error('the subscriber has no earlier version to take the secret URL');
      const draft = JSON.parse(row.document) as Record<string, unknown>;
      if (draft.kind !== 'webhook') throw new Error('only a webhook subscriber has a URL');
      const descriptor = secretWebhookUrlDescriptor(input.hiddenUrl);
      const document = canonicalWebhookSubscriber({ ...draft, version: input.version, url: descriptor });
      await this.#secrets.createSecretUrlSubscriberVersion({
        document,
        completeUrl: input.hiddenUrl,
        cipher: this.#cipher,
      });
      return { scheme: descriptor.scheme, host: descriptor.host, port: descriptor.port, sha256: descriptor.sha256 };
    });
  }

  /** A live webhook subscriber version: only it has a signing slot. */
  #webhookSubscriber(subscriberId: string, version: number): ExactOwner {
    const owner = exactOwner(this.#database, 'subscriber', subscriberId, version);
    const row = this.#database
      .prepare('SELECT document FROM subscriber_versions WHERE subscriber_id = ? AND version = ?')
      .get(subscriberId, version) as { document: string };
    if ((JSON.parse(row.document) as { kind?: unknown }).kind !== 'webhook')
      throw new Error('only a webhook subscriber has a signing secret');
    return owner;
  }

  async judgeKeySet(input: {
    readonly judgeId: string;
    readonly version: number;
    readonly hidden: HumanSecret;
  }): Promise<SecretReceipt> {
    return withEventWriterLease(this.#quiescer, async () => {
      const owner = this.#hostedJudge(input.judgeId, input.version);
      const generation = await this.#store(owner, 'judge-key', input.hidden.consume(), null, false, true);
      return { kind: 'judge-key', judgeId: input.judgeId, version: input.version, generation };
    });
  }

  async judgeKeyRotate(input: {
    readonly judgeId: string;
    readonly version: number;
    readonly hidden: HumanSecret;
  }): Promise<SecretReceipt> {
    return this.#quiescer.withExclusive(async () => {
      const owner = this.#hostedJudge(input.judgeId, input.version);
      const prior = this.#requiredCurrent(owner, 'judge-key');
      const retired = await this.#secrets.currentMaster();
      await this.#cipher.rotateAndReencrypt();
      const generation = await this.#store(owner, 'judge-key', input.hidden.consume(), prior, true);
      await this.#secrets.reconcileRetiredGenerations(this.#cipher);
      await this.#secrets.destroyRetiredMaster({
        keyId: retired.keyId,
        cipher: this.#cipher,
        quiescer: this.#quiescer,
      });
      return { kind: 'judge-key', judgeId: input.judgeId, version: input.version, generation };
    });
  }

  async targetUrlSet(input: {
    readonly targetId: string;
    readonly predecessorVersion?: number | undefined;
    readonly inertDraft?: Readonly<Record<string, unknown>> | undefined;
    readonly newVersion: number;
    readonly hiddenUrl: string;
  }): Promise<{ readonly scheme: string; readonly host: string; readonly port: number; readonly sha256: string }> {
    return withEventWriterLease(this.#quiescer, async () => {
      if (!Number.isSafeInteger(input.newVersion) || input.newVersion < 1)
        throw new Error('the new target version is a positive integer');
      const exactlyOne = (input.predecessorVersion === undefined ? 0 : 1) + (input.inertDraft === undefined ? 0 : 1);
      if (exactlyOne !== 1)
        throw new Error('a target URL needs exactly one explicit predecessor version or inert draft');
      let draft: Record<string, unknown>;
      if (input.predecessorVersion !== undefined) {
        const row = this.#database
          .prepare('SELECT document FROM target_versions WHERE target_id = ? AND version = ?')
          .get(input.targetId, input.predecessorVersion) as { document: string } | undefined;
        if (row === undefined) throw new Error('the explicit predecessor target version does not exist');
        draft = JSON.parse(row.document) as Record<string, unknown>;
      } else {
        draft = { ...(input.inertDraft as Record<string, unknown>) };
        if (draft.targetId !== undefined || draft.version !== undefined)
          throw new Error('an inert target draft has no identity');
      }
      const descriptor = secretWebhookUrlDescriptor(input.hiddenUrl);
      const document = canonicalWebhookTarget({
        ...draft,
        targetId: input.targetId,
        version: input.newVersion,
        url: descriptor,
      });
      await this.#secrets.createSecretUrlTargetVersion({
        document,
        completeUrl: input.hiddenUrl,
        cipher: this.#cipher,
      });
      return { scheme: descriptor.scheme, host: descriptor.host, port: descriptor.port, sha256: descriptor.sha256 };
    });
  }

  async migrateSecrets(input: {
    readonly from: EventSecretStoreKind;
    readonly to: EventSecretStoreKind;
    readonly source: SecretStore;
    readonly target: SecretStore;
  }): Promise<EventSecretMigrationResult> {
    return withEventWriterLease(this.#quiescer, () =>
      migrateEventSecrets({
        database: this.#database,
        paths: this.#paths,
        from: input.from,
        to: input.to,
        source: input.source,
        target: input.target,
        referenceCipher: this.#cipher,
      }),
    );
  }

  /** Terminal migration chooses only the destination kind; this owner resolves both independent event stores itself. */
  async migrateTo(to: EventSecretStoreKind): Promise<EventSecretMigrationResult> {
    return withEventWriterLease(this.#quiescer, () => this.#secrets.migrateTo(to, this.#cipher));
  }

  async #store(
    owner: ExactOwner,
    purpose: EventSecretPurpose,
    material: string,
    expectedPriorGeneration: number | null,
    retirePrevious: boolean,
    requireEmpty = false,
  ): Promise<number> {
    const generation = await this.#secrets.storeGeneration({
      owner,
      purpose,
      material,
      expectedPriorGeneration,
      retirePrevious,
      requireEmpty,
      cipher: this.#cipher,
    });
    return generation.generation;
  }

  #requiredCurrent(owner: ExactOwner, purpose: EventSecretPurpose): number {
    const generation = currentGeneration(this.#database, owner, purpose);
    if (generation === null) throw new Error('the exact secret slot has no current generation to rotate');
    return generation;
  }

  /** Whether each AI provider has a key: a closed, content-free list. */
  providerKeys(): readonly { readonly provider: EventSecretProvider; readonly hasKey: boolean }[] {
    return EVENT_SECRET_PROVIDERS.map((provider) => ({
      provider,
      hasKey: currentGeneration(this.#database, providerSecretOwner(provider), 'provider-key') !== null,
    }));
  }

  /**
   * Stores a provider's key, replacing any it had, and gives the same key to every live Jev judge version that provider
   * serves, so a replaced key takes effect at once. The key arrives as hidden input and is consumed once.
   */
  async providerKeySet(input: {
    readonly provider: EventSecretProvider;
    readonly hidden: HumanSecret;
  }): Promise<ProviderKeyReceipt> {
    return this.#quiescer.withExclusive(async () => {
      const owner = providerSecretOwner(input.provider);
      const material = input.hidden.consume();
      const judges = this.#hostedJudgesOf(input.provider);
      const prior = currentGeneration(this.#database, owner, 'provider-key');
      const rotating = prior !== null || judges.some((judge) => this.#judgeKeyDigest(judge) !== null);
      const retired = rotating ? await this.#secrets.currentMaster() : undefined;
      if (rotating) await this.#cipher.rotateAndReencrypt();
      await this.#store(owner, 'provider-key', material, prior, true);
      for (const judge of judges) await this.#giveJudgeKey(judge, material);
      if (rotating && retired !== undefined) {
        await this.#secrets.reconcileRetiredGenerations(this.#cipher);
        await this.#secrets.destroyRetiredMaster({
          keyId: retired.keyId,
          cipher: this.#cipher,
          quiescer: this.#quiescer,
        });
      }
      return { provider: input.provider, hasKey: true, judges: judges.length };
    });
  }

  /**
   * Removes a provider's key, and the copy each live Jev judge version of that provider holds: those judges are then
   * missing their key, and a call to them is refused before it is made, until a key is added again.
   */
  async providerKeyRemove(input: { readonly provider: EventSecretProvider }): Promise<ProviderKeyReceipt> {
    return this.#quiescer.withExclusive(async () => {
      const owner = providerSecretOwner(input.provider);
      await this.#secrets.retireCurrentGeneration({ owner, purpose: 'provider-key' });
      const judges = this.#hostedJudgesOf(input.provider);
      for (const judge of judges)
        await this.#secrets.retireCurrentGeneration({
          owner: exactOwner(this.#database, 'judge', judge.judgeId, judge.version),
          purpose: 'judge-key',
        });
      await this.#secrets.reconcileRetiredGenerations(this.#cipher);
      return { provider: input.provider, hasKey: false, judges: judges.length };
    });
  }

  /**
   * Gives one Jev judge version its provider's stored key (judge setup). Returns `unchanged` when it holds that key
   * already; refuses when the provider has no key, before anything is written.
   */
  async syncJudgeKeyFromProvider(input: {
    readonly judgeId: string;
    readonly version: number;
    readonly provider: EventSecretProvider;
  }): Promise<'stored' | 'unchanged'> {
    return this.#quiescer.withExclusive(async () => {
      const owner = providerSecretOwner(input.provider);
      const current = (
        await this.#secrets.readLiveGenerations({ owner, purpose: 'provider-key', cipher: this.#cipher })
      ).find((generation) => generation.lifecycle === 'current');
      if (current === undefined) throw new Error('the AI provider has no key to give its judge');
      const judge = { judgeId: input.judgeId, version: input.version, provider: input.provider };
      this.#hostedJudge(judge.judgeId, judge.version);
      if (this.#judgeKeyDigest(judge) === current.secretDigest) return 'unchanged';
      await this.#giveJudgeKey(judge, current.material);
      await this.#secrets.reconcileRetiredGenerations(this.#cipher);
      return 'stored';
    });
  }

  /** Every live Jev judge version the provider serves. */
  #hostedJudgesOf(provider: EventSecretProvider): readonly HostedJudgeVersion[] {
    const rows = this.#database
      .prepare(
        'SELECT judge_id, version, document FROM judge_versions WHERE revoked_at IS NULL ORDER BY judge_id, version',
      )
      .all() as Array<{ judge_id: string; version: number; document: string }>;
    return rows.flatMap((row) => {
      const document = JSON.parse(row.document) as { kind?: unknown; provider?: unknown };
      if (document.kind !== JUDGE_KIND_TYPESAFE || document.provider !== provider) return [];
      return [{ judgeId: row.judge_id, version: row.version, provider }];
    });
  }

  /** The digest of the key a judge version holds now, or null when it holds none. */
  #judgeKeyDigest(judge: HostedJudgeVersion): string | null {
    const row = this.#database
      .prepare(
        `SELECT secret_digest FROM event_secret_generations
         WHERE owner_kind = 'judge' AND owner_id = ? AND owner_version = ? AND purpose = 'judge-key' AND lifecycle = 'current'`,
      )
      .get(judge.judgeId, judge.version) as { secret_digest: string } | undefined;
    return row?.secret_digest ?? null;
  }

  /** Puts `material` in the judge version's slot, retiring what it held; nothing when it holds that key already. */
  async #giveJudgeKey(judge: HostedJudgeVersion, material: string): Promise<void> {
    if (this.#judgeKeyDigest(judge) === sha256Hex(material)) return;
    const owner = this.#hostedJudge(judge.judgeId, judge.version);
    const prior = currentGeneration(this.#database, owner, 'judge-key');
    await this.#store(owner, 'judge-key', material, prior, true);
  }

  #hostedJudge(judgeId: string, version: number): ExactOwner {
    const owner = exactOwner(this.#database, 'judge', judgeId, version);
    const document = this.#database
      .prepare('SELECT document FROM judge_versions WHERE judge_id = ? AND version = ?')
      .get(judgeId, version) as { document: string };
    if ((JSON.parse(document.document) as { kind?: unknown }).kind !== JUDGE_KIND_TYPESAFE)
      throw new Error('only the hosted judge kind has a credential slot');
    return owner;
  }

  #newSigningSecret(): string {
    // Standard Webhooks' `whsec_` secrets are standard base64, which `signStandardWebhook` checks byte for byte: a
    // base64url secret could never sign (0.36.0 found every generated one was refused there).
    return this.#secretMaterial?.nextSigningSecret() ?? `whsec_${randomBytes(32).toString('base64')}`;
  }

  #newToken(): string {
    return this.#secretMaterial?.nextSubscriberToken() ?? randomBytes(32).toString('base64url');
  }
}
