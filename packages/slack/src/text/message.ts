import { analyseLink, type SanitizedLink } from '@agentcomms/core';
import { reconcile, renderBlocks } from './blocks.ts';
import type { ReferenceNames, SlackReference } from './decode.ts';
import { type SenderField, senderBody, senderField } from './field.ts';

/**
 * One Slack message, read.
 *
 * Everything sender-controlled has been through `senderField`/`senderBody`, and the two halves of the message have
 * been reconciled. What is *not* here is as deliberate as what is: `username` never becomes the author, because
 * `chat:write.customize` lets an app pick any display name it likes; attribution is `user` and `bot_id`, which an
 * app cannot forge.
 */

/** Content Slack attached that the message's author did not write. */
export interface Unfurl {
  /** The URL whose preview this is. The attribution — an unfurl belongs to a page, not to the person who linked it. */
  readonly url: string;
  readonly title?: SenderField | undefined;
  readonly text?: SenderField | undefined;
  /** The service Slack says produced it, if any. Sender-controlled like everything else here. */
  readonly service?: SenderField | undefined;
}

export interface ReadMessage {
  readonly ts: string;
  readonly threadTs?: string | undefined;
  /** The author's id. `undefined` for a message with neither — which is itself worth showing rather than guessing. */
  readonly userId?: string | undefined;
  readonly botId?: string | undefined;
  /** What a person reads, safe to hand to a model. */
  readonly body: string;
  /** True when the message was longer than the body limit. */
  readonly truncated: boolean;
  /** Control tokens and envelope-shaped runs defused across the body and every field of this message. */
  readonly tokensNeutralised: number;
  /**
   * True when `text` and the rendered `blocks` say different things.
   *
   * A signal, never an error: it is how a message reads one way to an agent and another to the people in the
   * channel, so a reader is told rather than quietly shown one half.
   */
  readonly mismatch: boolean;
  /** The notification fallback, kept when it disagrees so a reader can see both halves. */
  readonly fallback?: string | undefined;
  readonly references: readonly SlackReference[];
  /** Every link in the body, with core's own analysis: punycode, lookalikes, text/domain mismatch. */
  readonly links: readonly SanitizedLink[];
  /** Content Slack attached that the author never wrote. Never merged into `body`. */
  readonly unfurls: readonly Unfurl[];
  readonly editedTs?: string | undefined;
  readonly replyCount?: number | undefined;
  readonly reactions?: readonly { name: string; count: number }[] | undefined;
  readonly files?: readonly { id: string; name?: SenderField | undefined; mimetype?: string | undefined }[] | undefined;
}

type Raw = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null) as Raw[]) : [];
}

/*
 * An attachment is an unfurl when Slack says where it came from.
 *
 * `from_url`/`original_url` are set on link previews; `is_app_unfurl` marks one an app produced for its own
 * domain. A legacy attachment with none of these was written by whoever posted the message, so it is the author's
 * content and is not labelled as somebody else's — mislabelling it would be a lie in the safer-sounding direction,
 * which is still a lie about who said something.
 */
function unfurlOf(attachment: Raw, names: ReferenceNames): Unfurl | null {
  const url = str(attachment.from_url) ?? str(attachment.original_url) ?? str(attachment.app_unfurl_url);
  if (!url && attachment.is_app_unfurl !== true) return null;
  const blocks = renderBlocks(attachment.blocks, names);
  const text = blocks !== '' ? blocks : str(attachment.text);
  return {
    url: url ?? '(an app’s own unfurl, with no source URL)',
    title: senderField(str(attachment.title), names),
    text: senderField(text, names, 2_000),
    service: senderField(str(attachment.service_name), names),
  };
}

/**
 * A raw Slack message, read.
 *
 * `names` resolves ids to names; anything it cannot resolve stays an id, which reads as an unresolved id rather
 * than borrowing the label Slack carried — that label is sender-controlled and is exactly where an impersonation
 * would put a name.
 */
export function readMessage(raw: Raw, names: ReferenceNames = {}): ReadMessage {
  const { shown, fallback, mismatch } = reconcile(str(raw.text), raw.blocks, names);
  const body = senderBody(shown, names);

  const unfurls = list(raw.attachments)
    .map((attachment) => unfurlOf(attachment, names))
    .filter((unfurl): unfurl is Unfurl => unfurl !== null);

  const files = list(raw.files).map((file) => ({
    id: str(file.id) ?? '',
    name: senderField(str(file.name), names),
    mimetype: str(file.mimetype),
  }));

  const reactions = list(raw.reactions).map((reaction) => ({
    name: str(reaction.name) ?? '',
    count: num(reaction.count) ?? 0,
  }));

  /*
   * Every field of this message, counted together.
   *
   * A caller that reads only the body's count would report a clean message whose file name carried a control
   * token. The number is a signal that something in *this message* tried something, so it is summed over
   * everything the message brought with it.
   */
  const tokensNeutralised =
    body.tokensNeutralised +
    unfurls.reduce(
      (total, unfurl) =>
        total +
        (unfurl.title?.tokensNeutralised ?? 0) +
        (unfurl.text?.tokensNeutralised ?? 0) +
        (unfurl.service?.tokensNeutralised ?? 0),
      0,
    ) +
    files.reduce((total, file) => total + (file.name?.tokensNeutralised ?? 0), 0);

  const links = body.references
    .filter((reference) => reference.kind === 'link')
    .map((reference) => analyseLink(reference.label ?? reference.id, reference.id));

  return {
    ts: str(raw.ts) ?? '',
    threadTs: str(raw.thread_ts),
    userId: str(raw.user),
    botId: str(raw.bot_id),
    body: body.text,
    truncated: body.truncated,
    tokensNeutralised,
    mismatch,
    ...(mismatch ? { fallback } : {}),
    references: body.references,
    links,
    unfurls,
    editedTs: str((raw.edited as Raw | undefined)?.ts),
    replyCount: num(raw.reply_count),
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}
