import {
  AGENT_LABEL_WORDS,
  type AgentLabelSettings,
  agentLabelOf,
  CommsError,
  collapseWhitespace,
  DEFAULT_AGENT_LABEL_WORD,
  decodeHeaderWords,
  type IdentityDecision,
  labelPhrase,
  type MessageIdentity,
  parseAddressList,
  resolveIdentity,
  truncateDisplay,
  UNLABELLED_PREVIEW_LINE,
} from '@agentcomms/core';
import type { SendAsAddress } from '../gmail-api/transport.ts';
import { formatAddress } from './compose.ts';

/**
 * Labelling what an agent sends from Gmail (design 2026-10-15-agent-label, §3 and §5): who a draft appears to come
 * from, and the From line that says so. The decisions are the core's (`resolveIdentity`, `labelPhrase`); this module
 * only says where Gmail's name comes from and how the From line is written and read back.
 */

/** Who a message may appear to come from, as `as` takes it (L3). */
export const IDENTITIES: readonly ['agent', 'me'] = ['agent', 'me'];

/** What `as` is, in a refusal of a word that is not one. */
export const IDENTITY_WORDS = 'who a message appears to come from';

/**
 * The longest a labelled From name may be. The design names Slack's 80 characters and Resend's 100, and no figure for
 * Gmail; a mail name is held to Resend's, so one name labels the same way in both mail channels.
 */
export const MAIL_LABEL_LIMIT = 100;

/**
 * The person's label settings from a loaded configuration, read by the core's `agentLabelOf`. The configuration's type
 * names `agentLabel` once the core carries it (the agent-label plan's task A1); until then the key is read as the
 * schema keeps it, an unknown top-level key of a loose object.
 */
export function labelSettingsOf(config: object): AgentLabelSettings {
  return agentLabelOf(config as { readonly agentLabel?: unknown });
}

/** L4's kind of a mail act: `reply` when it answers a message (it carries In-Reply-To), `send` otherwise. */
export function mailKind(inReplyTo: string | undefined): 'send' | 'reply' {
  return inReplyTo?.trim() ? 'reply' : 'send';
}

/** The name this mailbox goes by now, whatever name the call used: a rule names the account as it is called. */
export function accountNameOf(
  config: { readonly inboxes: Readonly<Record<string, { readonly id: string }>> },
  resolved: { readonly alias: string; readonly inbox: { readonly id: string } },
): string {
  return Object.entries(config.inboxes).find(([, inbox]) => inbox.id === resolved.inbox.id)?.[0] ?? resolved.alias;
}

/** Every address in a list of header entries, `Name <address>` or bare: what a rule's conversation is matched on. */
export function addressesOf(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => {
    const parsed = parseAddressList(entry);
    return parsed.length > 0 ? parsed.map((address) => address.address) : [entry.trim().toLowerCase()];
  });
}

/** A label refusal that says how to fix it, when the core's did not. */
function withLabelHint(error: unknown): unknown {
  if (!(error instanceof CommsError) || error.hint !== undefined) return error;
  return new CommsError(error.code, error.message, {
    hint: 'Set a name the label can use with `label name`.',
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error,
  });
}

/**
 * L1's phrase for this From address: the send-as display name Gmail holds for it, else the core's `agentLabel.name`,
 * else a refusal that says how to set one. A send-as name the label cannot use — too long with the word, or holding a
 * character L2 forbids — gives way to the core's name when there is one, and is refused when there is not.
 */
export function labelPhraseFor(options: {
  readonly address: string;
  readonly sendAs: readonly SendAsAddress[];
  readonly settings: AgentLabelSettings;
}): string {
  const word = options.settings.word ?? DEFAULT_AGENT_LABEL_WORD;
  const own = options.sendAs
    .find((entry) => entry.sendAsEmail.toLowerCase() === options.address.toLowerCase())
    ?.displayName?.trim();
  if (own) {
    try {
      return labelPhrase(own, word, MAIL_LABEL_LIMIT);
    } catch (error) {
      if (options.settings.name === undefined) throw withLabelHint(error);
    }
  }
  if (options.settings.name !== undefined) {
    try {
      return labelPhrase(options.settings.name, word, MAIL_LABEL_LIMIT);
    } catch (error) {
      throw withLabelHint(error);
    }
  }
  throw new CommsError('USAGE', 'this message is to be labelled as sent by your agent, and there is no name to label', {
    hint: 'Give the address a name in Gmail’s "Send mail as" settings, or set one with `label name`.',
  });
}

export interface MailIdentity {
  readonly identity: MessageIdentity;
  readonly decision: IdentityDecision;
  /** For `agent`: L1's phrase, `<name> (<word>)`. */
  readonly phrase?: string | undefined;
  /** The From this identity writes: `"<phrase>" <address>` for `agent`, the bare address for `me`. */
  readonly from: string;
}

/** L3 for one mail act, and the From it writes. */
export function mailIdentity(options: {
  readonly settings: AgentLabelSettings;
  readonly account: string;
  readonly kind: 'send' | 'reply';
  readonly requested: MessageIdentity | undefined;
  readonly recipients: readonly string[];
  readonly address: string;
  readonly sendAs: readonly SendAsAddress[];
}): MailIdentity {
  const decision = resolveIdentity(options.settings, {
    account: options.account,
    kind: options.kind,
    requested: options.requested,
    mail: { recipients: options.recipients },
  });
  if (decision.identity === 'me') return { identity: 'me', decision, from: options.address };
  const phrase = labelPhraseFor(options);
  return { identity: 'agent', decision, phrase, from: formatAddress({ name: phrase, address: options.address }) };
}

/** Whether a From name carries a label: it ends with ` (<word>)` for one of L2's words. */
export function labelledName(name: string): boolean {
  return AGENT_LABEL_WORDS.some((word) => name.endsWith(` (${word})`));
}

/**
 * A From header as a person reads it and the approval binds it (G3): decoded, its address canonical, its name quoted
 * when it needs to be — `"Jo Example (agent)" <jo@example.test>`, or the bare address. One that is not exactly one
 * address is shown decoded, as it stands.
 */
export function shownFrom(header: string | undefined): string {
  const parsed = parseAddressList(header ?? '');
  const only = parsed.length === 1 ? parsed[0] : undefined;
  if (only !== undefined) return formatAddress(only);
  return collapseWhitespace(decodeHeaderWords(header ?? ''));
}

/** Who a From header says a message comes from: labelled with its phrase, or as the person. */
export function identityOfFrom(header: string | undefined): { identity: MessageIdentity; phrase?: string } {
  const parsed = parseAddressList(header ?? '');
  const name = parsed.length === 1 ? (parsed[0]?.name ?? '') : '';
  return labelledName(name) ? { identity: 'agent', phrase: name } : { identity: 'me' };
}

/** Whether a draft's From already says what its identity needs, so nothing has to be rewritten (G2). */
export function fromFits(header: string | undefined, wanted: MailIdentity): boolean {
  const parsed = parseAddressList(header ?? '');
  const only = parsed.length === 1 ? parsed[0] : undefined;
  if (only === undefined) return false;
  return wanted.identity === 'agent' ? only.name === wanted.phrase : !labelledName(only.name);
}

/** L3: the first line of a preview — the label recipients will see, or that there is none. */
export function identityLine(identity: {
  readonly identity: MessageIdentity;
  readonly phrase?: string | undefined;
}): string {
  if (identity.identity === 'me' || identity.phrase === undefined) return UNLABELLED_PREVIEW_LINE;
  return `Sent as ${truncateDisplay(identity.phrase, 120)}: labelled in the From line, so whoever receives it can tell your agent sent it`;
}
