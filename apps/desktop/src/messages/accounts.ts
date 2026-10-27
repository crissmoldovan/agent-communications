/**
 * The accounts Messages names (spec 2026-10-26-owner-feedback-0320 §3.6): each account's name by its id, a Gmail
 * account's address and a Slack account's workspace, from `accounts` for each channel that is here. Since 0.35.0 a
 * Resend account's name too, which a take's message is joined to its account's taking settings by (design
 * 2026-10-26-taking-messages §9). A read that fails names none: the screens then show an account by its id.
 */
import type { Bridge, Product } from '../ipc.ts';

/** The accounts the app read: each one's name by its id, and what a link to it needs. */
export interface AccountsInfo {
  aliases: ReadonlyMap<string, string>;
  /** A Gmail account's address, by its id. */
  gmailAddresses: ReadonlyMap<string, string>;
  /** A Slack account's workspace id, by its id. */
  slackTeams: ReadonlyMap<string, string>;
}

export const NO_ACCOUNTS: AccountsInfo = { aliases: new Map(), gmailAddresses: new Map(), slackTeams: new Map() };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const word = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A list's entries: the answer itself when it is a list, or its `accounts` (Resend's). */
function entriesOf(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.accounts) ? data.accounts : [];
  return list.filter(isRecord);
}

/**
 * The accounts `accounts` lists for Gmail and Slack — and for Resend, with `resend` — read for their names; a read that
 * fails names none.
 */
export async function readAccounts(
  bridge: Bridge,
  present: readonly Product[],
  options: { resend?: boolean } = {},
): Promise<AccountsInfo> {
  const aliases = new Map<string, string>();
  const gmailAddresses = new Map<string, string>();
  const slackTeams = new Map<string, string>();
  const list = async (product: 'gmail' | 'slack' | 'resend'): Promise<Record<string, unknown>[]> => {
    if (!present.includes(product)) return [];
    try {
      const result = await bridge.cli({ kind: 'accounts', product });
      return result.status === 'ok' ? entriesOf(result.data) : [];
    } catch {
      return [];
    }
  };
  const [gmail, slack, resend] = await Promise.all([
    list('gmail'),
    list('slack'),
    options.resend === true ? list('resend') : Promise.resolve([]),
  ]);
  for (const inbox of gmail) {
    const id = word(inbox.id);
    const alias = word(inbox.alias);
    if (id === null) continue;
    if (alias !== null) aliases.set(id, alias);
    const address = word(inbox.email);
    if (address !== null) gmailAddresses.set(id, address);
  }
  for (const workspace of slack) {
    const id = word(workspace.accountId);
    const alias = word(workspace.alias);
    if (id === null) continue;
    if (alias !== null) aliases.set(id, alias);
    const team = word(workspace.workspaceId);
    if (team !== null) slackTeams.set(id, team);
  }
  for (const account of resend) {
    const id = word(account.id);
    const name = word(account.name) ?? word(account.alias);
    if (id !== null && name !== null) aliases.set(id, name);
  }
  return { aliases, gmailAddresses, slackTeams };
}
