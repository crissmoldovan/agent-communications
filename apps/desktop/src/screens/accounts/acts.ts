/**
 * What agents may do on one account (0.34.0's Agents here, spec 2026-10-26-desktop-0340 §B2), in the person's words,
 * and the one `behaviour` call each change to it is. The acts are core's for each channel (`operations/behaviour.ts`,
 * `ACTING`): Slack posts, replies, reacts, edits, deletes and shares files; Gmail sends and replies; Resend sends.
 * WhatsApp has none: it only drafts a link the person sends, so its page has no Agents here.
 */
import type { BehaviourAct, BehaviourReport } from '../../cli-types.ts';
import { KNOWN_ACTS } from '../../grammar.ts';
import { type Call, formatActs } from '../../ipc.ts';

/** The channels whose accounts act on other people. */
export type ActingChannel = 'gmail' | 'slack' | 'resend';

/** One act as the page names it: its switch's label and line, and the words a sentence uses for it. */
export interface ActWords {
  act: BehaviourAct;
  label: string;
  hint: string;
  /** In a list: "post, reply and react". */
  word: string;
  /** After "agents may": "post new messages". */
  verb: string;
}

/** Each channel's acts, in the order its switches show them. */
export const ACTS: Readonly<Record<ActingChannel, readonly ActWords[]>> = {
  slack: [
    { act: 'post', label: 'Post', hint: 'Start a new message in a channel', word: 'post', verb: 'post new messages' },
    { act: 'reply', label: 'Reply', hint: 'Answer in a thread', word: 'reply', verb: 'reply in threads' },
    { act: 'reaction', label: 'React', hint: 'Add an emoji reaction', word: 'react', verb: 'react with an emoji' },
    {
      act: 'edit',
      label: 'Edit',
      hint: 'Change a message sent from this account',
      word: 'edit',
      verb: 'edit messages',
    },
    {
      act: 'delete',
      label: 'Delete',
      hint: 'Remove a message sent from this account',
      word: 'delete',
      verb: 'delete messages',
    },
    {
      act: 'file',
      label: 'Share files',
      hint: 'Post a file from this computer',
      word: 'share files',
      verb: 'share files',
    },
  ],
  gmail: [
    { act: 'send', label: 'Send', hint: 'Write a new email', word: 'send new mail', verb: 'send new mail' },
    { act: 'reply', label: 'Reply', hint: 'Answer an email in its thread', word: 'reply', verb: 'reply to mail' },
  ],
  resend: [{ act: 'send', label: 'Send', hint: 'Send an email from this account', word: 'send', verb: 'send mail' }],
};

/** Whether a channel's accounts have an Agents here: every channel but WhatsApp. */
export function isActing(channel: string): channel is ActingChannel {
  return Object.hasOwn(ACTS, channel);
}

/** One account's line in the behaviour report. */
export type AccountBehaviour = BehaviourReport['accounts'][number];

/** The channel's acts an allowance holds, in the channel's order: every one for `all`. */
export function allowedActs(channel: ActingChannel, allowed: readonly BehaviourAct[] | 'all'): BehaviourAct[] {
  return ACTS[channel].map((each) => each.act).filter((act) => allowed === 'all' || allowed.includes(act));
}

/** Acts in a sentence: "post, reply and react", or "nothing". */
export function actsInWords(channel: ActingChannel, acts: readonly BehaviourAct[]): string {
  const words = ACTS[channel].filter((each) => acts.includes(each.act)).map((each) => each.word);
  if (words.length === 0) return 'nothing';
  if (words.length === 1) return words[0] as string;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The words of one act. */
export function actWords(channel: ActingChannel, act: BehaviourAct): ActWords {
  return ACTS[channel].find((each) => each.act === act) as ActWords;
}

/** Acts as the CLI takes them: in the allow-list's order, each once, or `none`. */
export function actsArgument(acts: readonly BehaviourAct[]): string {
  return formatActs(KNOWN_ACTS.filter((act) => acts.includes(act as BehaviourAct)));
}

/** Whether a rule for the whole account stands: only then is there one to clear. */
export function hasAccountRule(report: BehaviourReport, account: string): boolean {
  return report.rules.some((rule) => rule.account === account && rule.conversation === undefined);
}

/**
 * The change one switch is: off allows the rest, at once; on allows one act more, which core prepares. Turning on the
 * last act clears the account's rule, so the account is back to allowing what its channel does.
 */
export function switchCall(
  channel: ActingChannel,
  account: string,
  allowed: readonly BehaviourAct[] | 'all',
  act: BehaviourAct,
  on: boolean,
  accountRule: boolean,
): Extract<Call, { kind: 'behaviourAllow' | 'behaviourClear' }> {
  const now = allowedActs(channel, allowed);
  const next = on ? [...now, act] : now.filter((each) => each !== act);
  const every = ACTS[channel].every((each) => next.includes(each.act));
  if (on && every && accountRule) return { kind: 'behaviourClear', account };
  return { kind: 'behaviourAllow', account, acts: actsArgument(next) };
}

/** What one conversation, person or domain allows, as its line says it. */
export function overrideText(channel: ActingChannel, place: string, allowed: readonly BehaviourAct[] | 'all'): string {
  const acts = allowedActs(channel, allowed);
  const every = ACTS[channel].every((each) => acts.includes(each.act));
  if (channel === 'slack') {
    if (acts.length === 0) return 'Nothing: agents can’t act here';
    if (every) return 'Everything agents can do in Slack';
    const words = actsInWords(channel, acts);
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} only`;
  }
  if (acts.length === 0) {
    const whom = place.startsWith('@') ? 'anyone there' : 'them';
    return channel === 'gmail' ? `Never: no new mail, and no replies, to ${whom}` : `Never: no mail to ${whom}`;
  }
  if (every) return channel === 'gmail' ? 'Send and reply' : 'Send';
  return acts[0] === 'reply' ? 'Reply only' : 'Send new mail only';
}

/** "agents may post and reply", or "agents may do nothing". */
export function mayInWords(channel: ActingChannel, acts: readonly BehaviourAct[]): string {
  return acts.length === 0 ? 'agents may do nothing' : `agents may ${actsInWords(channel, acts)}`;
}

/** The call that approves, in the app, the behaviour change the page prepared: the same words, and its approval. */
export function approvedFor(
  call: Extract<Call, { kind: 'behaviourAllow' | 'behaviourClear' }>,
): (approvalId: string) => Call {
  const where = call.conversation === undefined ? {} : { conversation: call.conversation };
  return (approvalId) =>
    call.kind === 'behaviourAllow'
      ? { kind: 'behaviourAllowApproved', account: call.account, acts: call.acts, ...where, approvalId }
      : { kind: 'behaviourClearApproved', account: call.account, ...where, approvalId };
}

/** "in acme/slack" for Slack, where a message is posted; "from acme/gmail" for mail, which is sent from it. */
export function placeWord(channel: ActingChannel): 'in' | 'from' {
  return channel === 'slack' ? 'in' : 'from';
}
