/**
 * The payload, generated from the author's text — never accepted from a caller.
 *
 * Exactly as the Gmail composer generates the HTML part from the plain text, and for the same reason. `text` and
 * `blocks` are two descriptions of one message and Slack does not make them agree; a caller that supplied both
 * could make them say different things, and the difference is invisible to whoever approves the send because the
 * preview can only show one of them. So no tool here takes `blocks`: a caller supplies text, this renders the
 * blocks, and `text` is derived from the same source. The two cannot disagree because there is only one source.
 *
 * The preview then renders **from this payload**, not from the input that produced it — so what a person approves
 * is what will be posted, byte for byte, and the digest is taken over the same thing.
 */

/** The payload as it will be handed to `chat.postMessage`, and as the digest covers it. */
export interface ComposedPayload {
  /** The notification fallback. Derived from the same text as the blocks, so the two cannot diverge. */
  readonly text: string;
  readonly blocks: readonly unknown[];
  readonly channel: string;
  readonly thread_ts?: string | undefined;
  /**
   * Both off, on everything this package posts.
   *
   * They default to `true`. Slack's own security guidance says to disable them when an LLM may have generated
   * the URL, and that is exactly this package's case: an agent that can be talked into including a link should
   * not thereby be able to make a preview of that link appear in a channel, fetched by Slack, for everyone.
   */
  readonly unfurl_links: false;
  readonly unfurl_media: false;
}

/*
 * Slack's escaping, applied on the way out.
 *
 * The inverse of the decode on the way in, and needed for the same reason: a person writing `a < b` must not have
 * it read as the start of a span, and somebody writing `<@U024BE7LH>` in a draft must not thereby mention a
 * stranger. Only the three characters Slack documents — escaping more would show the extra ones literally.
 */
export function escapeForSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * A deliberate mention, written as Slack's own syntax.
 *
 * The author's text is escaped, so a mention cannot be smuggled through it; this is the one way to make one, and
 * it takes an id rather than a name — a name is ambiguous and a caller resolving one itself would be choosing who
 * gets notified from a string somebody else controls.
 */
export type Mention =
  | { readonly kind: 'user'; readonly id: string }
  /** A link to a channel. Notifies nobody — it is a reference, not a broadcast. */
  | { readonly kind: 'channel'; readonly id: string }
  /**
   * The ones that interrupt a room.
   *
   * Their own kind, because `channel` meant two completely different things when they shared one: a `<#C1>` link
   * that notifies nobody, and `<!channel>`, which notifies everybody. A caller asking for the first and getting
   * the second would have interrupted a room by accident, and the types could not tell them apart.
   */
  | { readonly kind: 'broadcast'; readonly who: 'here' | 'channel' | 'everyone' };

export function renderMention(mention: Mention): string {
  switch (mention.kind) {
    case 'user':
      return `<@${mention.id}>`;
    case 'channel':
      return `<#${mention.id}>`;
    default:
      return `<!${mention.who}>`;
  }
}

export interface ComposeInput {
  readonly channel: string;
  /** What the author wrote. Escaped on the way out; markup in it is shown, not interpreted. */
  readonly text: string;
  readonly threadTs?: string | undefined;
  /**
   * Who to notify, said explicitly.
   *
   * Separate from the text on purpose. Notifying people is the part of a post with a consequence beyond the
   * words — `@channel` in a room of four hundred is four hundred interruptions — so it is stated as data the
   * preview can count, rather than parsed back out of prose where a miscount is invisible.
   */
  readonly mentions?: readonly Mention[] | undefined;
}

/**
 * One message, composed.
 *
 * The blocks are a single `section` with `mrkdwn` text, which is what a person typing into Slack produces and
 * what every client renders identically. Nothing richer is offered: a composer that could build layouts would be
 * a composer whose output a preview could not faithfully show in a terminal, and the preview is the whole of the
 * safety story here.
 */
export function compose(input: ComposeInput): ComposedPayload {
  const mentions = (input.mentions ?? []).map(renderMention).join(' ');
  const body = escapeForSlack(input.text);
  const text = mentions === '' ? body : `${mentions} ${body}`;
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    channel: input.channel,
    ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
    unfurl_links: false,
    unfurl_media: false,
  };
}
