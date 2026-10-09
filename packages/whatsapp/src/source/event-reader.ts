import type { DatabaseSync } from 'node:sqlite';
import type { SchemaReport } from './schema.ts';
import { type ChatKind, chatKindOf, coreDataToIso, kindOf, type MessageKind, numeric, text } from './types.ts';

/**
 * The event reader deliberately keeps the source tuple before the presentation index derives sender information.
 * A row-id is available only to produce a stable checked-copy read order; it is never returned as identity.
 */
export interface RawEventMessage {
  readonly sourceOrder: number;
  readonly chatJid: string | null;
  readonly chatKind: ChatKind | null;
  readonly senderJidRaw: string | null;
  readonly stanzaId: string | null;
  /** Exactly false is eligible. A malformed, absent, or non-boolean Core Data value remains unknown. */
  readonly fromMe: boolean | null;
  readonly at: string | null;
  readonly kind: MessageKind;
  readonly body: string | null;
}

function rawFromMe(value: unknown): boolean | null {
  const number = numeric(value);
  if (number === 0) return false;
  if (number === 1) return true;
  return null;
}

/**
 * Reads only raw, checked-copy facts needed by the local event source.  It intentionally does not call
 * `rebuildIndex`, `WhatsAppIndex`, or any presentation sender fallback.
 */
export function readRawEventMessages(database: DatabaseSync, _report: SchemaReport): readonly RawEventMessage[] {
  const rows = database
    .prepare(
      `SELECT m.Z_PK AS sourceOrder, c.ZCONTACTJID AS chatJid, m.ZFROMJID AS senderJidRaw,
              m.ZSTANZAID AS stanzaId, m.ZISFROMME AS fromMe, m.ZMESSAGEDATE AS at,
              m.ZMESSAGETYPE AS typeCode, m.ZTEXT AS body
         FROM ZWAMESSAGE AS m
         LEFT JOIN ZWACHATSESSION AS c ON c.Z_PK = m.ZCHATSESSION
        ORDER BY m.Z_PK`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    const chatJid = text(row.chatJid)?.trim() || null;
    const type = numeric(row.typeCode);
    return {
      sourceOrder: numeric(row.sourceOrder) ?? 0,
      chatJid,
      chatKind: chatJid === null ? null : chatKindOf(chatJid),
      senderJidRaw: text(row.senderJidRaw)?.trim() || null,
      stanzaId: text(row.stanzaId)?.trim() || null,
      fromMe: rawFromMe(row.fromMe),
      at: coreDataToIso(numeric(row.at)),
      kind: kindOf(type).kind,
      body: text(row.body),
    };
  });
}
