/**
 * Slack's wire form, turned into what a person sees.
 *
 * Slack does two different things to a message before it reaches us, and conflating them is the bug this module
 * exists to avoid. It **escapes** three characters a person typed — `&`, `<` and `>` become `&amp;`, `&lt;` and
 * `&gt;` — and it **encodes** references as angle-bracket spans the person never typed at all: `<@U024BE7LH>`,
 * `<#C024BE7LR|general>`, `<https://example.test|the label>`, `<!here>`.
 *
 * The two look alike and must be read in one order only. A span is written with *literal* angle brackets, so it is
 * findable in the raw text; a typed `<` is not there to be found, because it arrived as `&lt;`. Decode the escapes
 * first and the two become indistinguishable: a person who types `<@U0|x>` into a message hands us something that
 * now parses as a mention. So this scans for spans against the raw text, and decodes escapes only in what lies
 * between them.
 *
 * Then, and only then, may the result be cut and neutralised — in that order, which is
 * `docs/superpowers/specs/2026-09-19-slack-design.md` §D5.4. Cutting first can halve a span or an entity;
 * neutralising first sees `&lt;/untrusted-email-content&gt;` as nothing to defuse and the decode that follows
 * hands the reader a live closing tag.
 */

/** What a span referred to, recorded so a caller can resolve ids to names without re-parsing the text. */
export interface SlackReference {
  readonly kind: 'user' | 'channel' | 'usergroup' | 'special' | 'link' | 'date';
  /** `U024BE7LH`, `C024BE7LR`, `S012`, `here`, or the URL. */
  readonly id: string;
  /** The label Slack carried after `|`, already unescaped. Sender-controlled: never trusted, never a name. */
  readonly label?: string | undefined;
}

export interface DecodedText {
  /** The text a person sees, with every span rendered and every escape undone. Not yet neutralised. */
  readonly text: string;
  /** Every span found, in the order it appeared. */
  readonly references: readonly SlackReference[];
}

/** How to render a referenced id. Returning `undefined` falls back to the id, which is always safe to show. */
export interface ReferenceNames {
  user?: (id: string) => string | undefined;
  channel?: (id: string) => string | undefined;
  usergroup?: (id: string) => string | undefined;
}

/*
 * The three escapes Slack applies, undone in one pass.
 *
 * One pass, not three: `&amp;lt;` is a person who typed `&lt;`, and decoding `&lt;` before `&amp;` turns it into a
 * `<` they never wrote. A single alternation consumes each escape once and moves past it.
 *
 * Slack escapes exactly these three and documents that it does not escape quotes, so nothing else belongs here —
 * a decoder that also handled `&quot;` would invent characters in the text of anyone who typed it literally.
 */
const ESCAPES = /&(amp|lt|gt);/g;

function unescapeSlack(text: string): string {
  return text.replace(ESCAPES, (_match, name: string) => (name === 'amp' ? '&' : name === 'lt' ? '<' : '>'));
}

/*
 * A span, matched against the raw text.
 *
 * `[^<>]*` for the body because a span cannot contain a literal angle bracket: a typed one arrived escaped, and
 * Slack does not nest spans. Bounding it this way also means an unclosed `<` in the raw text cannot make this scan
 * the rest of the message looking for a `>` that is not there.
 */
const SPAN = /<([^<>]*)>/g;

/** `<!date^1234567890^{date_short}|fallback>` — the fallback is what every client shows when it cannot render. */
function decodeDate(body: string, label: string | undefined): { text: string; reference: SlackReference } {
  const [, timestamp = ''] = /^!date\^(\d+)\^/.exec(body) ?? [];
  return {
    // Slack's own fallback, which is what a client without the locale shows. Better than reprinting the format string.
    text: label ?? `<!date^${timestamp}>`,
    reference: { kind: 'date', id: timestamp, ...(label === undefined ? {} : { label }) },
  };
}

/**
 * Slack's wire text as a person sees it, plus what it referred to.
 *
 * Every id that cannot be resolved renders as the id itself. That is deliberate: a mention of somebody whose name
 * we failed to fetch should read as `@U024BE7LH`, which is obviously an unresolved id, rather than silently
 * vanishing or borrowing the label Slack carried — the label half of a span is sender-controlled and is exactly
 * what an impersonation would put there.
 */
export function decodeSlackText(raw: string, names: ReferenceNames = {}): DecodedText {
  const references: SlackReference[] = [];
  let out = '';
  let cursor = 0;

  for (const match of raw.matchAll(SPAN)) {
    const [whole, body = ''] = match;
    const at = match.index;
    out += unescapeSlack(raw.slice(cursor, at));
    cursor = at + whole.length;

    // The label is everything after the first `|`; a URL may itself contain one, the label may contain anything.
    const bar = body.indexOf('|');
    const head = bar === -1 ? body : body.slice(0, bar);
    const label = bar === -1 ? undefined : unescapeSlack(body.slice(bar + 1));

    if (head.startsWith('@')) {
      const id = head.slice(1);
      references.push({ kind: 'user', id, ...(label === undefined ? {} : { label }) });
      out += `@${names.user?.(id) ?? id}`;
    } else if (head.startsWith('#')) {
      const id = head.slice(1);
      references.push({ kind: 'channel', id, ...(label === undefined ? {} : { label }) });
      out += `#${names.channel?.(id) ?? id}`;
    } else if (head.startsWith('!subteam^')) {
      const id = head.slice('!subteam^'.length);
      references.push({ kind: 'usergroup', id, ...(label === undefined ? {} : { label }) });
      out += `@${names.usergroup?.(id) ?? id}`;
    } else if (head.startsWith('!date^')) {
      const { text, reference } = decodeDate(head, label);
      references.push(reference);
      out += text;
    } else if (head.startsWith('!')) {
      // `<!here>`, `<!channel>`, `<!everyone>` — the ones that notify a room rather than a person.
      const id = head.slice(1);
      references.push({ kind: 'special', id, ...(label === undefined ? {} : { label }) });
      out += `@${id}`;
    } else if (head === '' && label === undefined) {
      // `<>` is not a span; it is two characters that happened to look like one.
      out += whole;
    } else {
      const url = unescapeSlack(head);
      references.push({ kind: 'link', id: url, ...(label === undefined ? {} : { label }) });
      /*
       * Both halves, always, when they differ.
       *
       * A link whose label is a different URL is the oldest trick there is, and showing only the label hides it
       * while showing only the URL loses what the person was told they were clicking. `analyseLink` in core flags
       * the mismatch; this makes sure the reader can see it without being told.
       */
      out += label === undefined || label === url ? url : `${label} (${url})`;
    }
  }
  out += unescapeSlack(raw.slice(cursor));
  return { text: out, references };
}
