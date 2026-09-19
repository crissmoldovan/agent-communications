/**
 * Permission tiers and what the granted scopes allow. Every tier also asks for `openid email`, which are non-sensitive
 * and give the stable account id (`sub`) used to key inboxes and to catch sign-ins with the wrong account.
 *
 * No scope separates drafting from sending: `gmail.compose` and `gmail.modify` both allow `drafts.send`. The send gate
 * is therefore enforced in code (see the approval engine), never by the grant.
 */

export const SCOPES = {
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailCompose: 'https://www.googleapis.com/auth/gmail.compose',
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  otherContacts: 'https://www.googleapis.com/auth/contacts.other.readonly',
} as const;

export type Tier = 'read' | 'draft' | 'organize';
export const TIERS: readonly Tier[] = ['read', 'draft', 'organize'];

export type Capability = 'read' | 'draft' | 'organize' | 'contacts';

/** The scopes to request for a tier (plus the contacts add-on). */
export function scopesFor(tier: Tier, contacts: boolean): string[] {
  const scopes: string[] = [SCOPES.openid, SCOPES.email];
  if (tier === 'read') scopes.push(SCOPES.gmailReadonly);
  if (tier === 'draft') scopes.push(SCOPES.gmailReadonly, SCOPES.gmailCompose);
  if (tier === 'organize') scopes.push(SCOPES.gmailModify);
  if (contacts) scopes.push(SCOPES.contacts, SCOPES.otherContacts);
  return scopes;
}

/**
 * Normalises a space-separated `scope` value into the full scope URLs the rest of this package compares against.
 *
 * Google's own token responses use full URLs, but not everything that writes a credentials file does. The legacy
 * `@artymclabin/gmail-mcp` server records the shorthand — `gmail.readonly gmail.compose` — and `inbox import` reads
 * exactly those files. Comparing shorthand against `https://www.googleapis.com/auth/gmail.readonly` matches nothing,
 * so every mailbox in a real six-account migration was skipped as "this grant cannot read the mailbox" when all six
 * could read perfectly well. Anything without a scheme is expanded to the `auth/` URL it is shorthand for.
 *
 * `openid` is left alone: it is a bare token by specification, not shorthand for a URL. `email` and `profile` are
 * aliases Google itself accepts for the `userinfo.*` URLs, so they are mapped rather than expanded.
 */
export function parseGrantedScopes(scope: string | undefined): string[] {
  const ALIASES: Record<string, string> = {
    email: SCOPES.email,
    profile: 'https://www.googleapis.com/auth/userinfo.profile',
  };
  const expand = (value: string): string => {
    if (value === SCOPES.openid) return value;
    if (ALIASES[value]) return ALIASES[value];
    if (value.includes('://')) return value;
    return `https://www.googleapis.com/auth/${value}`;
  };
  return [...new Set((scope ?? '').split(/\s+/).filter(Boolean).map(expand))];
}

/** What an inbox can do with the scopes it was actually granted (users can untick boxes on the consent screen). */
export function capabilitiesOf(granted: readonly string[]): Set<Capability> {
  const has = (scope: string) => granted.includes(scope);
  const caps = new Set<Capability>();
  if (has(SCOPES.gmailReadonly) || has(SCOPES.gmailModify)) caps.add('read');
  if (has(SCOPES.gmailCompose) || has(SCOPES.gmailModify)) caps.add('draft');
  if (has(SCOPES.gmailModify)) caps.add('organize');
  if (has(SCOPES.contacts) || has(SCOPES.otherContacts)) caps.add('contacts');
  return caps;
}

/** The highest tier the granted scopes support, or null when even reading is missing. */
export function tierOf(granted: readonly string[]): Tier | null {
  const caps = capabilitiesOf(granted);
  if (caps.has('organize')) return 'organize';
  if (caps.has('draft') && caps.has('read')) return 'draft';
  if (caps.has('read')) return 'read';
  return null;
}

/** The command that grants a missing capability, for SCOPE_MISSING hints. */
export function grantHint(alias: string, needed: Capability): string {
  if (needed === 'contacts') return `agent-gmail inbox reauth ${alias} --contacts`;
  const tier: Tier = needed === 'read' ? 'read' : needed === 'draft' ? 'draft' : 'organize';
  return `agent-gmail inbox reauth ${alias} --tier ${tier}`;
}
