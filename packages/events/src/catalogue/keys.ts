import { canonicalJson } from '../json.ts';

/** D4's canonical raw WhatsApp protocol key. */
export function whatsappMessageKey(chatJid: string, senderJidRaw: string, stanzaId: string): string {
  return canonicalJson(['wa-msg', chatJid, senderJidRaw, stanzaId]);
}
