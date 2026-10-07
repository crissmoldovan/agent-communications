import { analyseLink, type ChannelPreview, type PreviewAttachment, type PreviewNotifies } from '@agentcomms/core';
import type { Channel, NameBook } from '../operations/people.ts';
import { decodeSlackText } from '../text/decode.ts';
import type { SlackDraft } from './drafts.ts';
import { type SlackDraftFile, showsInline, WARN_FILE_BYTES } from './files.ts';

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
  /**
   * Why the room could not be read, when it could not — so whether this account has joined it was never checked. A
   * room that was read and has not been joined is refused before any preview (see `requireMember` in `send.ts`).
   */
  readonly membershipUnchecked?: string | undefined;
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
  const people = references
    .filter((reference) => reference.kind === 'user')
    .map((reference) => book.person(reference.id)?.displayName?.text ?? reference.id);
  /*
   * A mention nothing here can count: a user group (`<!subteam^S0123>`), or any `<!…>` other than the three room-wide
   * ones.
   *
   * The composer cannot write one — every mention it writes is checked, and the author's text is escaped — so this is
   * the gate's own backstop, for a draft that did not come from it. It used to count such a mention as nobody, which is
   * the one wrong answer: a group of four hundred approved under `chat` as a message to no one. So it is named, and its
   * reach is said to be unknown rather than given a number, which is what makes the post need a person at a terminal.
   */
  const uncounted = references
    .filter(
      (reference) =>
        reference.kind === 'usergroup' ||
        (reference.kind === 'special' && !['here', 'channel', 'everyone'].includes(reference.id)),
    )
    .map((reference) =>
      reference.kind === 'usergroup' ? `@${reference.id} (a user group)` : `@${reference.id} (a special mention)`,
    );

  /*
   * A broadcast reaches the room; individual mentions reach the people named.
   *
   * `@here` reaches only those currently online, which nothing here can know — so it is counted as the room and
   * the difference is stated in words rather than guessed at with a smaller number. Over-stating reach is the
   * safe direction for a number somebody is about to approve.
   */
  const broadcast = here || channel;
  const estimated = broadcast ? (memberCount ?? 0) : people.length;
  const unknown = [
    ...(broadcast && memberCount === undefined ? [countUnknown ?? 'the channel’s member count could not be read'] : []),
    ...(uncounted.length > 0 ? [`${uncounted.join(', ')} reaches people nothing here can count`] : []),
  ];
  return {
    here,
    channel,
    users: [...people, ...uncounted],
    estimated,
    ...(unknown.length > 0 ? { unknown: unknown.join('; ') } : {}),
  };
}

/**
 * The user ids a post mentions, for the digest.
 *
 * Ids, not the display names {@link notifiesOf} produces. The preview shows names because a person reads names;
 * the digest binds ids because a name is a mutable, sender-controlled string and an id is not. Feeding the
 * preview's names into the digest — which an earlier version did — made somebody renaming themselves between the
 * preview and the post void a perfectly good approval, and bound the approval to something its owner does not
 * control.
 */
export function mentionedUserIds(text: string): string[] {
  const { references } = decodeSlackText(text);
  return [
    ...new Set(references.filter((reference) => reference.kind === 'user').map((reference) => reference.id)),
  ].sort();
}

/** Every link in the outgoing text, in full — a shortener or a tracker is only visible with its query string. */
function linksOf(text: string): string[] {
  const { references } = decodeSlackText(text);
  return references.filter((reference) => reference.kind === 'link').map((reference) => reference.id);
}

/** A span in Slack's wire text, as `decodeSlackText` finds one: literal angle brackets, nothing nested. */
const SPAN = /<[^<>]*>/g;
/** A bare web address, as Slack links one by itself: the scheme, then up to a space, an angle bracket or a bar. */
const BARE_URL = /https?:\/\/[^\s<>|]+/gi;
/** What ends a sentence rather than an address: `see https://example.com.` links the address, not the full stop. */
const TRAILING = /[.,;:!?'")\]}]+$/;

/**
 * Every URL in a post's words, in the order they appear, each once: each link span, and each bare `http://` or
 * `https://` address — which Slack links by itself, span or not. For a post with files, whose words Slack may unfurl
 * (see `unfurlWarnings`).
 *
 * The bare ones are looked for between the spans, in the words as they read — the author's `&amp;` is an `&` in an
 * address — so a span is never read twice, and a mention is never read as an address.
 */
export function urlsInWords(text: string): string[] {
  const found: string[] = [];
  const bare = (between: string): void => {
    // No span is left in it, so this only undoes Slack's escaping.
    for (const match of decodeSlackText(between).text.matchAll(BARE_URL)) {
      const url = match[0].replace(TRAILING, '');
      if (url.length > url.indexOf('//') + 2) found.push(url);
    }
  };
  let cursor = 0;
  for (const match of text.matchAll(SPAN)) {
    bare(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const [reference] = decodeSlackText(match[0]).references;
    if (reference?.kind === 'link') found.push(reference.id);
  }
  bare(text.slice(cursor));
  return [...new Set(found)];
}

/**
 * The warning for a post with files whose words hold a link — issue #44. A mitigation, not a fix: there is none.
 *
 * A message goes out with `unfurl_links` and `unfurl_media` off (see `ComposedPayload`). The files' message goes out
 * through `files.completeUploadExternal`, which takes no such switch, so Slack may fetch a link in it and show that
 * page's preview to the whole room — content nobody here wrote or saw. The one way to keep a link from unfurling is to
 * post it as a message of its own, which is what the warning says.
 */
function unfurlWarnings(files: readonly SlackDraftFile[], urls: readonly string[]): string[] {
  if (files.length === 0 || urls.length === 0) return [];
  return [FILE_POST_UNFURLS];
}

/**
 * The warning `unfurlWarnings` gives a post with files. Exported so an edit with files, which warns about unfurling in
 * its own words — its links go out through `chat.update`, not a file share — can leave the post's out.
 */
export const FILE_POST_UNFURLS =
  'Slack may fetch a link in this post’s words and show its preview to everyone in the channel: Slack offers no way to turn that off for a post with files. To keep a link from unfurling, post it as a message of its own.';

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

/**
 * The files, each as it will leave: the name Slack shows, its size and type, the hash the approval is bound to, and the
 * real path it is read from — every one of them, so a person can tell exactly which file on their machine this is.
 */
function attachmentsOf(files: readonly SlackDraftFile[]): PreviewAttachment[] {
  return files.map((file) => ({
    filename: file.name,
    size: file.size,
    mimeType: file.mimeType,
    sha256: file.sha256,
    path: file.path,
  }));
}

/**
 * What about the files a reader should notice before saying yes: flags, never refusals.
 *
 * A large file, because a size is easy to read past and a 90 MiB export is rarely what somebody meant to put in a room.
 * And a file Slack shows in the channel itself — an image, a PDF, any kind of text — because a person may think of it
 * as "a file I am sending" when what everyone in the room will see is what is in it.
 */
function fileWarnings(files: readonly SlackDraftFile[]): string[] {
  const warnings: string[] = [];
  for (const file of files) {
    if (showsInline(file.mimeType)) {
      warnings.push(
        `Slack shows ${file.name} in the channel itself: everyone who reads the channel sees what is in it, not only its name`,
      );
    }
    if (file.size > WARN_FILE_BYTES) {
      warnings.push(
        `${file.name} is over 10 MiB (${file.size.toLocaleString('en-US')} bytes): check that it is the file you mean to share with the whole channel`,
      );
    }
  }
  return warnings;
}

export function previewOf(input: PreviewInput): ChannelPreview {
  const payload = input.draft.payload;
  const files = input.draft.files ?? [];
  /*
   * A post of text alone lists its link spans, as it always has: it posts with unfurling off, so a bare address in it
   * is only text. A post with files lists every address in its words, bare or not, because any of them may unfurl.
   */
  const links = files.length > 0 ? urlsInWords(payload.text) : linksOf(payload.text);
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
    // Only when there are files, so a post of text alone is the preview it always was.
    ...(files.length > 0 ? { attachments: attachmentsOf(files) } : {}),
    context: {
      workspace: input.workspace,
      draftId: input.draft.draftId,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      note: input.note ?? 'nothing has been posted',
    },
    links,
    ...(input.policy ? { policy: input.policy } : {}),
    warnings: [
      ...membershipWarnings(input.membershipUnchecked),
      ...warningsOf(payload.text),
      ...unfurlWarnings(files, links),
      ...fileWarnings(files),
    ],
  };
}

/** A room that could not be read, so whether this account has joined it is not known: said, not refused. */
function membershipWarnings(why: string | undefined): string[] {
  if (why === undefined) return [];
  return [
    `could not check whether this account is a member of the channel (${why}): if it has not joined it, this posts into a conversation it is not part of`,
  ];
}
