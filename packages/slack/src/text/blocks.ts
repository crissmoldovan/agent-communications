import { type DecodedText, decodeSlackText, type ReferenceNames, type SlackReference } from './decode.ts';

/**
 * Block Kit, rendered to the text a person sees — and compared with the `text` field that claims to say the same.
 *
 * `text` and `blocks` are two descriptions of one message and Slack does not make them agree. `blocks` is what a
 * person reads; `text` is the notification fallback and the first thing a naive API reader takes. A message whose
 * halves disagree reads one way to the agent and another to the human, which is the whole of the hazard: it is
 * how you get an instruction in front of a model that nobody in the channel can see.
 *
 * So reading renders the blocks and compares. A difference is **reported**, not repaired and not refused — the
 * same way the Gmail body pipeline reports a plain/HTML mismatch. It is a signal about the message, and a reader
 * that silently preferred one half would destroy exactly the evidence that something is wrong.
 */

/** Slack sends these shapes; we read them defensively because a workspace app can put anything in a message. */
type Block = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function list(value: unknown): Block[] {
  return Array.isArray(value) ? (value.filter((entry) => typeof entry === 'object' && entry !== null) as Block[]) : [];
}

/**
 * One `rich_text` element.
 *
 * This is what Slack actually sends for anything a person typed in the client, and its leaves carry ids rather
 * than the `<@U…>` spans the `text` field uses — so the same reference arrives in two different encodings
 * depending on which half of the message you read. Both end up at the same names here.
 */
function renderRichElement(element: Block, names: ReferenceNames, into: SlackReference[]): string {
  const type = str(element.type);
  switch (type) {
    case 'text':
      return str(element.text) ?? '';
    case 'link': {
      const url = str(element.url) ?? '';
      const label = str(element.text);
      into.push({ kind: 'link', id: url, ...(label === undefined ? {} : { label }) });
      return label === undefined || label === url ? url : `${label} (${url})`;
    }
    case 'user': {
      const id = str(element.user_id) ?? '';
      into.push({ kind: 'user', id });
      return `@${names.user?.(id) ?? id}`;
    }
    case 'channel': {
      const id = str(element.channel_id) ?? '';
      into.push({ kind: 'channel', id });
      return `#${names.channel?.(id) ?? id}`;
    }
    case 'usergroup': {
      const id = str(element.usergroup_id) ?? '';
      into.push({ kind: 'usergroup', id });
      return `@${names.usergroup?.(id) ?? id}`;
    }
    case 'emoji':
      return `:${str(element.name) ?? ''}:`;
    case 'broadcast':
      return `@${str(element.range) ?? 'channel'}`;
    default:
      // An element type we do not know is still content somebody will read; showing its text beats dropping it.
      return str(element.text) ?? '';
  }
}

function renderRich(block: Block, names: ReferenceNames, into: SlackReference[]): string {
  const lines: string[] = [];
  for (const section of list(block.elements)) {
    /*
     * A list's children are sections of their own, not elements.
     *
     * Rendering `elements` directly produced the empty string for every bulleted list — and an empty render was
     * then read as "this message has no blocks", which substituted the notification fallback and reported no
     * mismatch. So the one block type people use most turned the mismatch check off for that message.
     */
    if (str(section.type) === 'rich_text_list') {
      for (const item of list(section.elements)) {
        const text = list(item.elements)
          .map((element) => renderRichElement(element, names, into))
          .join('');
        lines.push(`• ${text}`);
      }
      continue;
    }
    const inner = list(section.elements)
      .map((element) => renderRichElement(element, names, into))
      .join('');
    if (str(section.type) === 'rich_text_quote') {
      lines.push(
        inner
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      );
      continue;
    }
    lines.push(inner);
  }
  return lines.join('\n');
}

/**
 * A `text` object on a block: `plain_text` is literal, `mrkdwn` carries spans that have to be decoded.
 *
 * **Open question, deliberately left alone.** Slack documents escaping of `&`, `<` and `>` for message text; it
 * does not say whether a `plain_text` object arrives escaped too. Unescaping one that was not would invent
 * characters in the text of anybody who typed `&amp;` literally; leaving one that was escaped shows `&amp;`
 * where a person sees `&`. The first corrupts content, the second is a display nit, so this takes the second
 * until a real workspace settles it — the same way `docs/research/2026-09-22-slack-live-verification.md`
 * settled PKCE.
 */
function renderTextObject(value: unknown, names: ReferenceNames, into: SlackReference[]): string {
  if (typeof value !== 'object' || value === null) return '';
  const block = value as Block;
  const raw = str(block.text) ?? '';
  if (str(block.type) === 'plain_text') return raw;
  const decoded = decodeSlackText(raw, names);
  into.push(...decoded.references);
  return decoded.text;
}

/**
 * Block Kit as text.
 *
 * Deliberately plain: this exists to be compared with `text` and to be read, not to reproduce Slack's layout. A
 * renderer that tried to be faithful would differ from `text` for formatting reasons and make every message look
 * like a mismatch, which would train a reader to ignore the one signal this is for.
 */
export interface RenderedBlocks extends DecodedText {
  /** True when there were blocks at all — distinct from whether anything could be rendered from them. */
  readonly present: boolean;
  /** True when blocks were present and carried content, but nothing renderable came out of them. */
  readonly unrenderable: boolean;
}

/*
 * Block types this renderer understands.
 *
 * Everything else is *visible content it cannot show*, which is a different thing from an empty block and has to
 * be reported as such. Slack adds block types — `markdown`, `table`, `video`, `file` are all current — and a
 * renderer that silently drops one while another renders successfully hands a reader a message with a hole in it
 * and no indication there is a hole. `divider` is visible but carries no text, so it is not a hole.
 */
const RENDERABLE = new Set(['rich_text', 'section', 'header', 'context', 'image', 'actions', 'divider']);

export function renderBlocksFull(blocks: unknown, names: ReferenceNames = {}): RenderedBlocks {
  const references: SlackReference[] = [];
  const out: string[] = [];
  const blockList = list(blocks);
  let missed = false;
  for (const block of blockList) {
    const type = str(block.type);
    if (type !== undefined && !RENDERABLE.has(type)) {
      missed = true;
      // Still try for text, so a block we cannot lay out at least contributes what it says.
      const salvaged = renderTextObject(block.text, names, references);
      if (salvaged !== '') out.push(salvaged);
      continue;
    }
    switch (type) {
      case 'rich_text':
        out.push(renderRich(block, names, references));
        break;
      case 'section': {
        const body = renderTextObject(block.text, names, references);
        const fields = list(block.fields)
          .map((field) => renderTextObject(field, names, references))
          .filter(Boolean);
        out.push([body, ...fields].filter(Boolean).join('\n'));
        break;
      }
      case 'header':
        out.push(renderTextObject(block.text, names, references));
        break;
      case 'context':
        out.push(
          list(block.elements)
            .map((element) =>
              str(element.type) === 'image'
                ? (str(element.alt_text) ?? '')
                : renderTextObject(element, names, references),
            )
            .filter(Boolean)
            .join(' '),
        );
        break;
      case 'image': {
        const title = renderTextObject(block.title, names, references);
        const alt = str(block.alt_text) ?? '';
        out.push([title, alt && `[image: ${alt}]`].filter(Boolean).join('\n'));
        break;
      }
      case 'actions':
        out.push(
          list(block.elements)
            .map((element) => renderTextObject(element.text, names, references))
            .filter(Boolean)
            .map((label) => `[${label}]`)
            .join(' '),
        );
        break;
      default:
        break;
    }
  }
  const text = out.filter((part) => part !== '').join('\n\n');
  /*
   * "No blocks", "blocks that rendered to nothing" and "blocks that partly rendered" are three different facts.
   *
   * The first two were collapsed once, which made an unrenderable payload look like a plain-text message and
   * turned the mismatch check off for it. The third is subtler and was wrong for longer: a message with one
   * section and one `video` block rendered the section, produced non-empty text, and reported nothing missing —
   * so a reader saw part of a message with no sign that the rest existed.
   */
  const meaningful = blockList.filter((block) => str(block.type) !== 'divider');
  return {
    text,
    references,
    present: blockList.length > 0,
    unrenderable: missed || (text === '' && meaningful.length > 0),
  };
}

/** The text alone, for callers that only want to read it. */
export function renderBlocks(blocks: unknown, names: ReferenceNames = {}): string {
  return renderBlocksFull(blocks, names).text;
}

/*
 * Whitespace only.
 *
 * The comparison has to ignore the difference between `text`'s newlines and a block boundary, or every ordinary
 * message is a mismatch; it must not ignore anything else, or the mismatch it exists to catch slips through as
 * "just formatting". So: collapse runs of whitespace and trim, and compare what is left exactly.
 */
function forComparison(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface Reconciliation {
  /** What a person reads, decoded exactly once, with the references it carried. */
  readonly shown: DecodedText;
  /** The notification fallback, decoded exactly once. */
  readonly fallback: DecodedText;
  /** True when the two say different things beyond whitespace. A signal about the message, never an error. */
  readonly mismatch: boolean;
  /** True when blocks were present and carried content that produced nothing readable. */
  readonly unrenderable: boolean;
}

/**
 * What the message says, and whether its two halves agree.
 *
 * Both halves come back **decoded, once**. Everything downstream cuts and neutralises them and decodes nothing:
 * a second decode would read the characters a person typed as Slack's own encoding, and `&lt;@U1|x&gt;` — which
 * is somebody typing angle brackets — would become a real mention of U1.
 *
 * When there are no blocks, `text` is the message and there is nothing to disagree with. When blocks are present
 * but nothing renderable came out of them, that is reported: the fallback is shown because it is all there is,
 * and `unrenderable` says the visible half could not be read, rather than pretending the message was plain text.
 */
export function reconcile(text: string | undefined, blocks: unknown, names: ReferenceNames = {}): Reconciliation {
  const fallback = decodeSlackText(text ?? '', names);
  const rendered = renderBlocksFull(blocks, names);
  if (rendered.text === '') {
    /*
     * Nothing rendered. Whether that is fine depends on whether there were blocks at all: a plain-text message
     * has none and the fallback *is* the message, while blocks that produced nothing mean the half a person
     * reads could not be read here — and the mismatch check could not run, so reporting `false` would be a
     * claim nobody checked.
     */
    return { shown: fallback, fallback, mismatch: false, unrenderable: rendered.present };
  }
  return {
    shown: { text: rendered.text, references: rendered.references },
    fallback,
    mismatch: forComparison(rendered.text) !== forComparison(fallback.text),
    unrenderable: rendered.unrenderable,
  };
}
