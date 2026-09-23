import { analyseLink, type ChannelPreview, type PreviewNotifies } from '@agentcomms/core';
import type { Channel, NameBook } from '../operations/people.ts';
import { decodeSlackText } from '../text/decode.ts';
import type { SlackDraft } from './drafts.ts';

/**
 * What a person is shown before anything is posted.
 *
 * Rendered **from the payload that will be posted**, never from the input that produced it. That is the whole
 * point: the Gmail release's most serious defect was a preview showing `=?UTF-8?Q?Caf=C3=A9_plan?=` for a subject
 * the recipient read as `Café plan`, because nothing decoded what the composer itself had encoded. A person
 * cannot approve what they cannot read. Here the same rule means `<@U123>` is shown as the name it will render
 * as, and `&amp;` as `&`.
 *
 * And it is **not neutralised**. This is the person's own outgoing text; defusing a `Human:` in it would make the
 * preview differ from the post again — the same bug wearing a safety hat. The terminal is protected by
 * `escapeForDisplay` in the renderer instead, and the approval digest is taken over the decoded form, so what was
 * read is what is bound.
 */

export interface PreviewInput {
  readonly draft: SlackDraft;
  readonly workspace: string;
  /** Who this posts as: the connected account, as a person should read it. */
  readonly postingAs: string;
  readonly channel: Channel | undefined;
  readonly book: NameBook;
  /** How many people are in the channel, when it could be established. Never guessed. */
  readonly memberCount?: number | undefined;
  /** Why the count is missing, when it is. */
  readonly countUnknown?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly policy?: string | undefined;
  readonly note?: string | undefined;
}

/**
 * Who a post will interrupt.
 *
 * The number is the point, and it is the one thing a channel preview must do that a mail preview does not.
 * `@channel` is eight characters whether the room holds three people or four hundred, and a person approving the
 * four-hundred case is agreeing to something quite different. A mail preview lists its recipients and the reader
 * counts them; here nobody can count what they cannot see, so this counts for them — or says it could not.
 */
export function notifiesOf(
  payload: { text: string },
  book: NameBook,
  memberCount: number | undefined,
  countUnknown: string | undefined,
): PreviewNotifies {
  const { references } = decodeSlackText(payload.text);
  const here = references.some((reference) => reference.kind === 'special' && reference.id === 'here');
  const channel = references.some(
    (reference) => reference.kind === 'special' && (reference.id === 'channel' || reference.id === 'everyone'),
  );
  const users = references
    .filter((reference) => reference.kind === 'user')
    .map((reference) => book.person(reference.id)?.displayName?.text ?? reference.id);

  /*
   * A broadcast reaches the room; individual mentions reach the people named.
   *
   * `@here` reaches only those currently online, which nothing here can know — so it is counted as the room and
   * the difference is stated in words rather than guessed at with a smaller number. Over-stating reach is the
   * safe direction for a number somebody is about to approve.
   */
  const broadcast = here || channel;
  const estimated = broadcast ? (memberCount ?? 0) : users.length;
  return {
    here,
    channel,
    users,
    estimated,
    ...(broadcast && memberCount === undefined
      ? { unknown: countUnknown ?? 'the channel’s member count could not be read' }
      : {}),
  };
}

/** Every link in the outgoing text, in full — a shortener or a tracker is only visible with its query string. */
function linksOf(text: string): string[] {
  const { references } = decodeSlackText(text);
  return references.filter((reference) => reference.kind === 'link').map((reference) => reference.id);
}

/** Warnings about the person's own text: not refusals, just what a reader should notice before saying yes. */
function warningsOf(text: string): string[] {
  const warnings: string[] = [];
  const { references } = decodeSlackText(text);
  for (const reference of references) {
    if (reference.kind !== 'link') continue;
    const analysis = analyseLink(reference.label ?? reference.id, reference.id);
    for (const flag of analysis.flags) {
      warnings.push(`the link to ${analysis.domain ?? reference.id} is flagged: ${flag}`);
    }
  }
  return warnings;
}

export function previewOf(input: PreviewInput): ChannelPreview {
  const payload = input.draft.payload;
  // Decoded, because that is what the recipient reads — see this module's own note.
  const body = decodeSlackText(payload.text, input.book.names()).text;
  const channelName = input.channel?.isIm
    ? (input.book.person(input.channel.withUserId ?? '')?.displayName?.text ?? 'a direct message')
    : `#${input.channel?.name?.text ?? payload.channel}`;

  return {
    workspace: input.workspace,
    postingAs: input.postingAs,
    channel: channelName,
    ...(payload.thread_ts ? { thread: `a reply in the thread at ${payload.thread_ts}` } : {}),
    body,
    notifies: notifiesOf(payload, input.book, input.memberCount, input.countUnknown),
    context: {
      workspace: input.workspace,
      draftId: input.draft.draftId,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      note: input.note ?? 'nothing has been posted',
    },
    links: linksOf(payload.text),
    ...(input.policy ? { policy: input.policy } : {}),
    warnings: warningsOf(payload.text),
  };
}
