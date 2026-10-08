import {
  canonicalJson,
  catalogueEntry,
  conditionPointers,
  getPointer,
  type JsonValue,
  parsePointer,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import type { AadComponent } from '../store/aad.ts';
import type { EventDatabase } from '../store/database.ts';
import { fixedDeadline } from '../store/retention.ts';
import { sanitiseSenderFields } from './untrusted.ts';

export interface ProjectionCipher {
  encrypt(
    location: { readonly table: string; readonly column: string; readonly key: readonly AadComponent[] },
    plaintext: Uint8Array,
  ): Promise<Buffer>;
  decrypt(
    location: { readonly table: string; readonly column: string; readonly key: readonly AadComponent[] },
    stored: unknown,
  ): Promise<Buffer>;
}

export interface StoredProjection {
  readonly event: Record<string, unknown>;
}

export interface ProjectionReference {
  readonly eventId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly decisionDeadline: number;
  readonly encryptedProjection: Uint8Array;
}

function decodePointer(pointer: string): readonly string[] {
  const parsed = parsePointer(pointer);
  if (!parsed.ok) throw new Error(parsed.issues[0]?.message ?? 'a projection pointer is invalid');
  return parsed.value.map(String);
}

function setAt(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const tokens = decodePointer(pointer);
  if (tokens.length === 0) throw new Error('a projection cannot replace its root');
  let current: Record<string, unknown> = target;
  for (const token of tokens.slice(0, -1)) {
    const next = current[token];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[token] = created;
      current = created;
    }
  }
  current[tokens.at(-1) as string] = JSON.parse(JSON.stringify(value));
}

function mappingPointers(node: unknown, into: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) mappingPointers(item, into);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$path === 'string') into.add(record.$path);
  for (const value of Object.values(record)) mappingPointers(value, into);
}

/** Retains only the exact rule's condition/mapping fields plus CloudEvent's structural fields, never a shared full event. */
export function minimiseProjection(rule: CanonicalFullRuleDocument, event: Record<string, unknown>): StoredProjection {
  const pointers = new Set<string>([
    '/id',
    '/type',
    '/version',
    '/occurredAt',
    '/observedAt',
    '/account/id',
    '/messageId',
  ]);
  for (const pointer of conditionPointers(rule.condition)) pointers.add(pointer);
  mappingPointers(rule.mapping, pointers);
  const projection: Record<string, unknown> = {};
  for (const pointer of pointers) {
    const found = getPointer(event as JsonValue, pointer);
    if (found.found) setAt(projection, pointer, found.value);
  }
  return { event: projection };
}

export class EventProjectionStore {
  readonly #store: EventDatabase;
  readonly #cipher: ProjectionCipher;

  constructor(options: { readonly store: EventDatabase; readonly cipher: ProjectionCipher }) {
    this.#store = options.store;
    this.#cipher = options.cipher;
  }

  async insert(input: {
    readonly eventId: string;
    readonly rule: CanonicalFullRuleDocument;
    readonly event: Record<string, unknown>;
    readonly stagedAt: number;
    /** The source stage this projection is built from; a stage purged during the encryption is not recreated. */
    readonly stageId?: string | undefined;
    /** D9: reads core's configuration for the event's account after the encryption; throws once it is gone. */
    readonly accountLive?: (() => Promise<void>) | undefined;
  }): Promise<boolean> {
    const exists = this.#store.database
      .prepare('SELECT 1 AS present FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .get(input.eventId, input.rule.ruleId, input.rule.version);
    if (exists !== undefined) return true;
    const location = {
      table: 'ingest_rules',
      column: 'encryptedProjection',
      key: [
        { type: 'text' as const, value: input.eventId },
        { type: 'text' as const, value: input.rule.ruleId },
        { type: 'integer' as const, value: input.rule.version },
      ],
    };
    const definition = catalogueEntry(input.rule.event.type, input.rule.event.version);
    if (!definition.ok)
      throw new Error(definition.issues[0]?.message ?? 'the projection event definition is unavailable');
    const sanitised = sanitiseSenderFields(definition.value, input.event);
    const encrypted = await this.#cipher.encrypt(
      location,
      Buffer.from(canonicalJson(minimiseProjection(input.rule, sanitised))),
    );
    const deadline = fixedDeadline(input.stagedAt, input.rule.retention.ingestMs);
    await input.accountLive?.();
    // The encryption awaited: a disable-all, a revocation or an account purge may have removed this work meanwhile.
    // Insert only while its stage (when it has one), its rule version and the switch are all still live; otherwise
    // there is nothing to keep, and a purged projection is never recreated (D12).
    return this.#store.immediate(() => {
      const database = this.#store.database;
      if (input.stageId !== undefined) {
        const stage = database.prepare('SELECT 1 AS present FROM source_scan_state WHERE id = ?').get(input.stageId);
        if (stage === undefined) return false;
      }
      // A revoked version keeps its immutable row as `revoked`, so a revocation during the encryption is visible here.
      const rule = database
        .prepare('SELECT state, revoked_at FROM rule_versions WHERE rule_id = ? AND version = ?')
        .get(input.rule.ruleId, input.rule.version) as { state: string | null; revoked_at: number | null } | undefined;
      if (rule !== undefined && (rule.revoked_at !== null || rule.state === 'revoked')) return false;
      const settings = database.prepare('SELECT enabled FROM event_settings WHERE singleton = 1').get() as
        | { enabled: number }
        | undefined;
      if (settings?.enabled !== 1) return false;
      database
        .prepare(
          `INSERT OR IGNORE INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.eventId, input.rule.ruleId, input.rule.version, deadline, encrypted);
      return true;
    });
  }

  row(eventId: string, ruleId: string, ruleVersion: number): ProjectionReference | null {
    const row = this.#store.database
      .prepare(
        `SELECT event_id, rule_id, rule_version, decision_deadline, encrypted_projection
         FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?`,
      )
      .get(eventId, ruleId, ruleVersion) as
      | {
          event_id: string;
          rule_id: string;
          rule_version: number;
          decision_deadline: number;
          encrypted_projection: Uint8Array;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          eventId: row.event_id,
          ruleId: row.rule_id,
          ruleVersion: row.rule_version,
          decisionDeadline: row.decision_deadline,
          encryptedProjection: row.encrypted_projection,
        };
  }

  async read(row: ProjectionReference): Promise<StoredProjection> {
    const bytes = await this.#cipher.decrypt(
      {
        table: 'ingest_rules',
        column: 'encryptedProjection',
        key: [
          { type: 'text', value: row.eventId },
          { type: 'text', value: row.ruleId },
          { type: 'integer', value: row.ruleVersion },
        ],
      },
      row.encryptedProjection,
    );
    return JSON.parse(bytes.toString('utf8')) as StoredProjection;
  }
}
