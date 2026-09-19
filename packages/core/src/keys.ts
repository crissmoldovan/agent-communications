import { randomBytes } from 'node:crypto';
import type { SecretStore } from './secrets.ts';

/** Secret-store reference of the key that seals MCP elicitation state and other server-minted handles. */
export const APPROVAL_KEY_REF = 'agent-communications:approval-key';

/**
 * Returns the 32-byte approval key, creating it on first use. The key never leaves the secret store except into the
 * memory of the process that uses it.
 */
export async function getOrCreateApprovalKey(store: SecretStore): Promise<Buffer> {
  const existing = await store.get(APPROVAL_KEY_REF);
  if (existing) {
    const key = Buffer.from(existing, 'base64');
    if (key.length === 32) return key;
  }
  const key = randomBytes(32);
  await store.set(APPROVAL_KEY_REF, key.toString('base64'));
  return key;
}
