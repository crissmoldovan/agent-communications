import { analyseLink, newBoundary, type SanitizedLink, wrapUntrusted } from '@agentcomms/core';
import { reconcile, renderBlocksFull } from './blocks.ts';
import type { ReferenceNames, SlackReference } from './decode.ts';
import { finishField, type SenderField, senderField } from './field.ts';

/**
 * One Slack message, read.
 *
 * Everything sender-controlled has been through `senderField`/`senderBody`, and the two halves of the message have
 * been reconciled. What is *not* here is as deliberate as what is: `username` never becomes the author, because
 * `chat:write.customize` lets an app pick any display name it likes; attribution is `user` and `bot_id`, which an
 * app cannot forge.
 */

/**
 * Who said it — from the fields an app cannot choose.
 *
 * `chat:write.customize` lets an app set any display name and avatar it likes, so a human skimming the channel
 * sees whatever it picked. The payload still tells the truth: `user` and `bot_id` are assigned by Slack. So the
 * attribution here is derived from those, an app-posted message is labelled as one, and the name the app chose is
 * carried *as well* — marked as chosen, never as identity — because that is what the people in the channel saw,
 * and the gap between the two is the thing worth reporting.
 */
export interface Attribution {
  /** Slack's own id for the person. Absent for a message posted by an app rather than a person. */
  readonly userId?: string | undefined;
  /** Slack's own id for the app. Present means an app posted this. */
  readonly botId?: string | undefined;
  /** True when an app posted it, whatever name it wore. */
  readonly app: boolean;
  /** The app's registered name, from `bot_profile` — not the per-message override. */
  readonly appName?: SenderField | undefined;
  /**
   * The display name this message was posted under, when the app chose one.
   *
   * Never used as identity and never matched against anything. It is here because it is what a person in the
   * channel read, and a message whose chosen name differs from the app that sent it is worth seeing as such.
   */
  readonly chosenName?: SenderField | undefined;
  /** The workspace the author belongs to; differs from ours in a Slack Connect channel. */
  readonly teamId?: string | undefined;
  /**
   * True when the author is outside this workspace.
   *
   * From `is_stranger` and `team_id` together, as the research requires: `is_stranger` is not always present, and
   * a `team_id` that is not ours is the other half of the same fact.
   */
  readonly external: boolean;
}

/** Content the message's author attached themselves — not an unfurl, and not to be labelled as one. */
export interface AuthoredAttachment {
  /** Shown above the attachment in the client. */
  readonly pretext?: SenderField | undefined;
  readonly authorName?: SenderField | undefined;
  readonly title?: SenderField | undefined;
  readonly text?: SenderField | undefined;
  /** Slack's legacy `fields`, which render as a small table inside the attachment. */
  readonly fields: readonly { title?: SenderField | undefined; value?: SenderField | undefined }[];
  readonly footer?: SenderField | undefined;
  /** True when the attachment carried blocks this renderer could not show. */
  readonly unrenderable: boolean;
}

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
  /** Who said it, from the fields an app cannot choose. */
  readonly attribution: Attribution;
  /**
   * Everything sender-controlled in this message, inside one envelope.
   *
   * One, and no bare copy beside it. An envelope exists to tell a model that what it is reading is data rather
   * than instruction; returning the same text unwrapped in the next field makes that marking optional, and a
   * caller serialising the result hands over both. So the body, the notification fallback when it disagrees, the
   * author's own attachments and anything Slack unfurled all arrive here, each under a heading that says what it
   * is and — for an unfurl — whose page it came from.
   *
   * Short metadata is different and stays outside: a file name, a channel name, an app's name. Those are
   * neutralised where they are read, as the Gmail package does with a filename, because a table of them inside an
   * envelope would be unreadable and they are not prose anybody argues with.
   */
  readonly enveloped: string;
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
  /**
   * True when blocks were present but produced nothing readable.
   *
   * Distinct from a plain-text message, and worth saying: the half a person sees could not be read here, so the
   * fallback below is all there is and the mismatch check could not run on this message.
   */
  readonly unrenderable: boolean;
  /** The notification fallback, neutralised, kept when it disagrees so a reader can see both halves. */
  readonly fallback?: string | undefined;
  readonly references: readonly SlackReference[];
  /**
   * What the notification half referred to, when it disagrees.
   *
   * Kept separate rather than merged: they are references in text nobody in the channel read, and a caller
   * resolving names needs them without treating them as part of the message.
   */
  readonly fallbackReferences: readonly SlackReference[];
  /** Every link in the body, with core's own analysis: punycode, lookalikes, text/domain mismatch. */
  readonly links: readonly SanitizedLink[];
  /** Content Slack attached that the author never wrote. Never merged into `body`. */
  readonly unfurls: readonly Unfurl[];
  /** Content the author attached themselves. Kept, and attributed to them rather than to a page. */
  readonly attachments: readonly AuthoredAttachment[];
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
function classifyAttachment(
  attachment: Raw,
  names: ReferenceNames,
): { unfurl: Unfurl } | { authored: AuthoredAttachment } {
  /*
   * An attachment's blocks are rendered — which decodes them — so what comes back must be *finished*, not decoded
   * a second time. Running it through `senderField` again turned a typed `&lt;@U1|literal&gt;` inside an
   * attachment into a resolved mention: the same double-decode the top-level body had, one level down.
   */
  const rendered = renderBlocksFull(attachment.blocks, names);
  const fromBlocks = rendered.text !== '' ? finishField(rendered, 2_000) : undefined;
  const text = fromBlocks ?? senderField(str(attachment.text), names, 2_000);

  const url = str(attachment.from_url) ?? str(attachment.original_url) ?? str(attachment.app_unfurl_url);
  if (!url && attachment.is_app_unfurl !== true) {
    /*
     * The poster's own attachment, kept whole.
     *
     * An earlier version returned nothing here, so its title and text vanished; the version after that kept two
     * fields and dropped the rest. Everything a person reads in the channel is carried: Slack's legacy attachment
     * shows `pretext` above it, `author_name` beside it, `fields` as a table inside it and `footer` below.
     */
    return {
      authored: {
        pretext: senderField(str(attachment.pretext), names),
        authorName: senderField(str(attachment.author_name), names),
        title: senderField(str(attachment.title), names),
        text,
        fields: list(attachment.fields).map((field) => ({
          title: senderField(str(field.title), names),
          value: senderField(str(field.value), names, 1_000),
        })),
        footer: senderField(str(attachment.footer), names),
        unrenderable: rendered.unrenderable,
      },
    };
  }
  return {
    unfurl: {
      url: url ?? '(an app’s own unfurl, with no source URL)',
      title: senderField(str(attachment.title), names),
      text,
      service: senderField(str(attachment.service_name), names),
    },
  };
}

/** Who said it, from the fields Slack assigns rather than the ones an app picks. */
function attributionOf(raw: Raw, names: ReferenceNames, ourTeamId?: string): Attribution {
  const botProfile = (raw.bot_profile as Raw | undefined) ?? {};
  const botId = str(raw.bot_id);
  /*
   * Slack puts the author's workspace in different places depending on the shape: `user_team` on a Slack Connect
   * message, `team` on an ordinary one, `source_team` on some search results. Reading only one of them reported
   * an outsider as a colleague, which is the direction that matters.
   */
  const teamId = str(raw.user_team) ?? str(raw.team) ?? str(raw.source_team);
  return {
    userId: str(raw.user),
    botId,
    app: botId !== undefined || str(raw.subtype) === 'bot_message',
    appName: senderField(str(botProfile.name), names),
    chosenName: senderField(str(raw.username), names),
    teamId,
    external: raw.is_stranger === true || (ourTeamId !== undefined && teamId !== undefined && teamId !== ourTeamId),
  };
}

/**
 * A raw Slack message, read.
 *
 * `names` resolves ids to names; anything it cannot resolve stays an id, which reads as an unresolved id rather
 * than borrowing the label Slack carried — that label is sender-controlled and is exactly where an impersonation
 * would put a name.
 */
export interface ReadMessageOptions {
  names?: ReferenceNames | undefined;
  /** This workspace's own team id, so an author from another one is reported as external. */
  ourTeamId?: string | undefined;
  /** One boundary per response, so a model sees a consistent marker across every message in it. */
  boundary?: string | undefined;
  /** The account name, for the envelope — a model reading two workspaces needs to tell them apart. */
  accountName?: string | undefined;
}

export function readMessage(raw: Raw, options: ReadMessageOptions = {}): ReadMessage {
  const names = options.names ?? {};
  const ourTeamId = options.ourTeamId;
  const { shown, fallback, mismatch, unrenderable } = reconcile(str(raw.text), raw.blocks, names);
  /*
   * Cut and neutralise. No second decode — `reconcile` already decoded both halves exactly once, and decoding
   * again would read a person's typed `<@U1|x>` as a real mention.
   */
  const body = finishField(shown);
  // The fallback is sender-controlled too, and is shown to a reader whenever the halves disagree.
  const fallbackField = mismatch ? finishField(fallback, 2_000) : undefined;

  const classified = list(raw.attachments).map((attachment) => classifyAttachment(attachment, names));
  const unfurls = classified.flatMap((entry) => ('unfurl' in entry ? [entry.unfurl] : []));
  const attachments = classified.flatMap((entry) => ('authored' in entry ? [entry.authored] : []));

  const files = list(raw.files).map((file) => ({
    id: str(file.id) ?? '',
    name: senderField(str(file.name), names),
    mimetype: str(file.mimetype),
  }));

  const reactions = list(raw.reactions).map((reaction) => ({
    name: str(reaction.name) ?? '',
    count: num(reaction.count) ?? 0,
  }));

  const attribution = attributionOf(raw, names, ourTeamId);

  /*
   * Every field of this message, counted together.
   *
   * A caller that reads only the body's count would report a clean message whose file name carried a control
   * token. The number is a signal that something in *this message* tried something, so it is summed over
   * everything the message brought with it.
   */
  const tokensNeutralised =
    body.tokensNeutralised +
    (fallbackField?.tokensNeutralised ?? 0) +
    unfurls.reduce(
      (total, unfurl) =>
        total +
        (unfurl.title?.tokensNeutralised ?? 0) +
        (unfurl.text?.tokensNeutralised ?? 0) +
        (unfurl.service?.tokensNeutralised ?? 0),
      0,
    ) +
    files.reduce((total, file) => total + (file.name?.tokensNeutralised ?? 0), 0) +
    attachments.reduce(
      (total, attachment) =>
        total + (attachment.title?.tokensNeutralised ?? 0) + (attachment.text?.tokensNeutralised ?? 0),
      0,
    ) +
    (attribution.appName?.tokensNeutralised ?? 0) +
    (attribution.chosenName?.tokensNeutralised ?? 0);

  const links = body.references
    .filter((reference) => reference.kind === 'link')
    .map((reference) => analyseLink(reference.label ?? reference.id, reference.id));

  /*
   * The parts, in the order a person meets them, each labelled.
   *
   * The labels matter as much as the wrapping: an unfurl is a stranger's page and a fallback is the half nobody
   * reads, and a model that cannot tell them from the author's own words has been handed a message that is not
   * the one that was sent.
   */
  const sections = [body.text];
  if (fallbackField)
    sections.push(`--- notification text, which differs from what is shown ---\n${fallbackField.text}`);
  for (const attachment of attachments) {
    const parts = [
      attachment.pretext?.text,
      attachment.authorName?.text && `by ${attachment.authorName.text}`,
      attachment.title?.text,
      attachment.text?.text,
      ...attachment.fields.map((field) => [field.title?.text, field.value?.text].filter(Boolean).join(': ')),
      attachment.footer?.text,
    ].filter((part) => part !== undefined && part !== '');
    if (parts.length > 0) sections.push(`--- attached by the author ---\n${parts.join('\n')}`);
  }
  for (const unfurl of unfurls) {
    const parts = [unfurl.title?.text, unfurl.text?.text].filter((part) => part !== undefined && part !== '');
    sections.push(`--- unfurled from ${unfurl.url} — the author did not write this ---\n${parts.join('\n')}`);
  }
  const enveloped = wrapUntrusted(
    sections.join('\n\n'),
    {
      field: 'message',
      id: str(raw.ts) ?? '',
      ...(options.accountName === undefined ? {} : { inbox: options.accountName }),
    },
    options.boundary ?? newBoundary(),
  );

  return {
    ts: str(raw.ts) ?? '',
    threadTs: str(raw.thread_ts),
    userId: str(raw.user),
    botId: str(raw.bot_id),
    attribution,
    enveloped,
    truncated: body.truncated,
    tokensNeutralised,
    mismatch,
    ...(fallbackField ? { fallback: fallbackField.text } : {}),
    unrenderable,
    references: body.references,
    fallbackReferences: fallbackField?.references ?? [],
    links,
    unfurls,
    attachments,
    editedTs: str((raw.edited as Raw | undefined)?.ts),
    replyCount: num(raw.reply_count),
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}
