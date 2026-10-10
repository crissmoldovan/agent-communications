import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretStore } from '@agentcomms/core';
import type { HumanSecret } from '../domain/human-secret.ts';
import { canonicalWebhookTarget, secretWebhookUrlDescriptor } from '../domain/webhook-target.ts';
import {
  type EventSecretMigrationResult,
  type EventSecretOwner,
  type EventSecretPurpose,
  type EventSecretStore,
  type EventSecretStoreKind,
  migrateEventSecrets,
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
  | { readonly kind: 'judge-key'; readonly judgeId: string; readonly version: number; readonly generation: number };

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
  readonly #subscriberStreams: SubscriberStreams | undefined;
  /** Test-only deterministic material seam; production always uses fresh random material below. */
  readonly #secretMaterial: Readonly<{ nextSigningSecret(): string; nextSubscriberToken(): string }> | undefined;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly paths: EventPaths;
    readonly secrets: EventSecretStore;
    readonly cipher: EventRecordCipher;
    readonly quiescer: WriterQuiescer;
    readonly subscriberStreams?: SubscriberStreams | undefined;
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
      const generation = await this.#store(owner, 'webhook-signing', this.#newSigningSecret(), null, false, true);
      return { kind: 'target-secret', targetId: input.targetId, version: input.version, generation };
    });
  }

  async targetSecretRotate(input: { readonly targetId: string; readonly version: number }): Promise<SecretReceipt> {
    return this.#quiescer.withExclusive(async () => {
      const owner = exactOwner(this.#database, 'target', input.targetId, input.version);
      const prior = this.#requiredCurrent(owner, 'webhook-signing');
      const retired = await this.#secrets.currentMaster();
      await this.#cipher.rotateAndReencrypt();
      const generation = await this.#store(owner, 'webhook-signing', this.#newSigningSecret(), prior, false);
      await this.#secrets.destroyRetiredMaster({
        keyId: retired.keyId,
        cipher: this.#cipher,
        quiescer: this.#quiescer,
      });
      return { kind: 'target-secret', targetId: input.targetId, version: input.version, generation };
    });
  }

  async subscriberTokenCreate(input: {
    readonly subscriberId: string;
    readonly version: number;
  }): Promise<SecretReceipt> {
    return withEventWriterLease(this.#quiescer, async () => {
      const owner = exactOwner(this.#database, 'subscriber', input.subscriberId, input.version);
      const generation = await this.#store(owner, 'sse-bearer', this.#newToken(), null, false, true);
      return { kind: 'subscriber-token', subscriberId: input.subscriberId, version: input.version, generation };
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
      const generation = await this.#store(owner, 'sse-bearer', this.#newToken(), prior, true);
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
      return { kind: 'subscriber-token', subscriberId: input.subscriberId, version: input.version, generation };
    });
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

  #hostedJudge(judgeId: string, version: number): ExactOwner {
    const owner = exactOwner(this.#database, 'judge', judgeId, version);
    const document = this.#database
      .prepare('SELECT document FROM judge_versions WHERE judge_id = ? AND version = ?')
      .get(judgeId, version) as { document: string };
    if ((JSON.parse(document.document) as { kind?: unknown }).kind !== 'typesafe')
      throw new Error('only the hosted judge kind has a credential slot');
    return owner;
  }

  #newSigningSecret(): string {
    return this.#secretMaterial?.nextSigningSecret() ?? `whsec_${randomBytes(32).toString('base64url')}`;
  }

  #newToken(): string {
    return this.#secretMaterial?.nextSubscriberToken() ?? randomBytes(32).toString('base64url');
  }
}
