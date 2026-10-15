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
import { encodeFromField, formatAddress } from './compose.ts';

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

/** L3 for one mail act: the message's `as`, then the most specific rule, then `agent`. */
export function mailDecision(options: {
  readonly settings: AgentLabelSettings;
  readonly account: string;
  readonly kind: 'send' | 'reply';
  readonly requested: MessageIdentity | undefined;
  readonly recipients: readonly string[];
}): IdentityDecision {
  return resolveIdentity(options.settings, {
    account: options.account,
    kind: options.kind,
    requested: options.requested,
    mail: { recipients: options.recipients },
  });
}

/** The From an identity writes for this address: the label for `agent`, the bare address for `me`. */
export function mailFrom(
  decision: IdentityDecision,
  options: {
    readonly address: string;
    readonly sendAs: readonly SendAsAddress[];
    readonly settings: AgentLabelSettings;
  },
): MailIdentity {
  if (decision.identity === 'me') return { identity: 'me', decision, from: options.address };
  const phrase = labelPhraseFor(options);
  return { identity: 'agent', decision, phrase, from: formatAddress({ name: phrase, address: options.address }) };
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
  return mailFrom(mailDecision(options), options);
}

/**
 * The addresses this mailbox may send as: its own, and each send-as address Gmail has verified. A draft from any
 * other address is not relabelled (G2): its label would name somebody this mailbox cannot speak for.
 */
export function sendableAddresses(own: string, sendAs: readonly SendAsAddress[]): Set<string> {
  const addresses = new Set([own.toLowerCase()]);
  for (const entry of sendAs) {
    if (entry.verificationStatus === undefined || entry.verificationStatus === 'accepted')
      addresses.add(entry.sendAsEmail.toLowerCase());
  }
  return addresses;
}

/**
 * G2: the raw message with its From header field replaced, and every other byte as it was — the header block's other
 * fields, their order and folding, the blank line, the body and every part. The new field is the composer's own
 * encoding of `from`, folded with the message's own line ending. A message with no From gains one at the top; one with
 * two is refused, since which of them a recipient sees is not this package's to guess.
 */
export function rewriteFromField(raw: Buffer, from: string): Buffer {
  // Byte for byte: every byte is one latin1 code unit, and the field written is ASCII.
  const text = raw.toString('latin1');
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');
  const usesCrlf = crlf >= 0 ? lf < 0 || crlf < lf : text.includes('\r\n');
  const newline = usesCrlf ? '\r\n' : '\n';
  const blank = usesCrlf ? crlf : lf;
  const head = blank < 0 ? text : text.slice(0, blank + newline.length);
  const field = encodeFromField(from).replaceAll('\r\n', newline);
  const pattern = usesCrlf
    ? /(^|\r\n)(From:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/gi
    : /(^|\n)(From:[^\n]*(?:\n[ \t][^\n]*)*)/gi;
  const found = [...head.matchAll(pattern)];
  if (found.length > 1) {
    throw new CommsError('BAD_DATA', 'this draft has more than one From line, so it cannot be labelled', {
      hint: 'Review it and send it from Gmail.',
    });
  }
  const match = found[0];
  if (match === undefined) return Buffer.from(`${field}${newline}${text}`, 'latin1');
  const start = (match.index ?? 0) + (match[1] ?? '').length;
  const end = start + (match[2] ?? '').length;
  return Buffer.from(`${text.slice(0, start)}${field}${text.slice(end)}`, 'latin1');
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
