import type { DatabaseSync } from 'node:sqlite';
import type { EventSecretOwner, EventSecretPurpose, EventSecretStore } from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';

export class ObjectSecretReadinessError extends Error {
  readonly code = 'OBJECT_SECRET_INCOMPLETE' as const;

  constructor() {
    super('the exact object version has an incomplete required secret slot');
    this.name = 'ObjectSecretReadinessError';
  }
}

type ReadinessOwner = Pick<EventSecretOwner, 'kind' | 'id' | 'version'>;

function expectedSlots(
  database: DatabaseSync,
  owner: ReadinessOwner,
): { readonly owner: EventSecretOwner; readonly slots: readonly EventSecretPurpose[] } {
  const table =
    owner.kind === 'target'
      ? 'target_versions'
      : owner.kind === 'subscriber'
        ? 'subscriber_versions'
        : 'judge_versions';
  const idColumn = owner.kind === 'target' ? 'target_id' : owner.kind === 'subscriber' ? 'subscriber_id' : 'judge_id';
  const row = database
    .prepare(`SELECT document, digest, revoked_at FROM ${table} WHERE ${idColumn} = ? AND version = ?`)
    .get(owner.id, owner.version) as { document: string; digest: string; revoked_at: number | null } | undefined;
  if (row === undefined || row.revoked_at !== null) throw new ObjectSecretReadinessError();
  const document = JSON.parse(row.document) as { kind?: unknown; url?: { kind?: unknown } };
  if (owner.kind === 'target') {
    if (document.kind !== 'webhook') return { owner: { ...owner, digest: row.digest }, slots: [] };
    return {
      owner: { ...owner, digest: row.digest },
      slots: document.url?.kind === 'secret' ? ['secret-url', 'webhook-signing'] : ['webhook-signing'],
    };
  }
  if (owner.kind === 'subscriber') return { owner: { ...owner, digest: row.digest }, slots: ['sse-bearer'] };
  return {
    owner: { ...owner, digest: row.digest },
    slots: document.kind === 'typesafe' ? ['judge-key'] : [],
  };
}

/**
 * One owner-side gate for exact immutable objects. It deliberately reads the
 * selected secret backend too: a ledger generation with a missing physical
 * value is incomplete rather than becoming effective later at delivery.
 */
export async function assertObjectSecretReady(input: {
  readonly database: DatabaseSync;
  readonly secrets: Pick<EventSecretStore, 'readLiveGenerations'>;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly owner: ReadinessOwner;
}): Promise<{ readonly ready: true }> {
  const expected = expectedSlots(input.database, input.owner);
  try {
    for (const purpose of expected.slots) {
      const generations = await input.secrets.readLiveGenerations({
        owner: expected.owner,
        purpose,
        cipher: input.cipher,
      });
      if (generations.length === 0) throw new ObjectSecretReadinessError();
    }
  } catch (error) {
    if (error instanceof ObjectSecretReadinessError) throw error;
    throw new ObjectSecretReadinessError();
  }
  return { ready: true };
}
