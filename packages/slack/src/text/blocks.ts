import { decodeSlackText, type ReferenceNames } from './decode.ts';

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
function renderRichElement(element: Block, names: ReferenceNames): string {
  const type = str(element.type);
  switch (type) {
    case 'text':
      return str(element.text) ?? '';
    case 'link': {
      const url = str(element.url) ?? '';
      const label = str(element.text);
      return label === undefined || label === url ? url : `${label} (${url})`;
    }
    case 'user': {
      const id = str(element.user_id) ?? '';
      return `@${names.user?.(id) ?? id}`;
    }
    case 'channel': {
      const id = str(element.channel_id) ?? '';
      return `#${names.channel?.(id) ?? id}`;
    }
    case 'usergroup': {
      const id = str(element.usergroup_id) ?? '';
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

function renderRich(block: Block, names: ReferenceNames): string {
  const lines: string[] = [];
  for (const section of list(block.elements)) {
    const inner = list(section.elements)
      .map((element) => renderRichElement(element, names))
      .join('');
    switch (str(section.type)) {
      case 'rich_text_quote':
        lines.push(
          inner
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        );
        break;
      case 'rich_text_preformatted':
        lines.push(inner);
        break;
      case 'rich_text_list':
        lines.push(inner);
        break;
      default:
        lines.push(inner);
    }
  }
  return lines.join('\n');
}

/** A `text` object on a block: `plain_text` is literal, `mrkdwn` carries spans that have to be decoded. */
function renderTextObject(value: unknown, names: ReferenceNames): string {
  if (typeof value !== 'object' || value === null) return '';
  const block = value as Block;
  const raw = str(block.text) ?? '';
  return str(block.type) === 'plain_text' ? raw : decodeSlackText(raw, names).text;
}

/**
 * Block Kit as text.
 *
 * Deliberately plain: this exists to be compared with `text` and to be read, not to reproduce Slack's layout. A
 * renderer that tried to be faithful would differ from `text` for formatting reasons and make every message look
 * like a mismatch, which would train a reader to ignore the one signal this is for.
 */
export function renderBlocks(blocks: unknown, names: ReferenceNames = {}): string {
  const out: string[] = [];
  for (const block of list(blocks)) {
    switch (str(block.type)) {
      case 'rich_text':
        out.push(renderRich(block, names));
        break;
      case 'section': {
        const body = renderTextObject(block.text, names);
        const fields = list(block.fields)
          .map((field) => renderTextObject(field, names))
          .filter(Boolean);
        out.push([body, ...fields].filter(Boolean).join('\n'));
        break;
      }
      case 'header':
        out.push(renderTextObject(block.text, names));
        break;
      case 'context':
        out.push(
          list(block.elements)
            .map((element) =>
              str(element.type) === 'image' ? (str(element.alt_text) ?? '') : renderTextObject(element, names),
            )
            .filter(Boolean)
            .join(' '),
        );
        break;
      case 'image': {
        const title = renderTextObject(block.title, names);
        const alt = str(block.alt_text) ?? '';
        out.push([title, alt && `[image: ${alt}]`].filter(Boolean).join('\n'));
        break;
      }
      case 'actions':
        out.push(
          list(block.elements)
            .map((element) => renderTextObject(element.text, names))
            .filter(Boolean)
            .map((label) => `[${label}]`)
            .join(' '),
        );
        break;
      case 'divider':
        break;
      default:
        // Unknown block types still carry text somebody sees.
        out.push(renderTextObject(block.text, names));
    }
  }
  return out.filter((part) => part !== '').join('\n\n');
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
  /** What a person reads: the blocks when there are any, otherwise `text`. */
  readonly shown: string;
  /** The notification fallback, decoded. */
  readonly fallback: string;
  /** True when the two say different things beyond whitespace. A signal about the message, never an error. */
  readonly mismatch: boolean;
}

/**
 * What the message says, and whether its two halves agree.
 *
 * When there are no blocks there is nothing to disagree with and `text` is the message. When there are, the blocks
 * are what a person reads — so they are `shown`, and `text` being different is the thing worth saying out loud.
 */
export function reconcile(text: string | undefined, blocks: unknown, names: ReferenceNames = {}): Reconciliation {
  const fallback = decodeSlackText(text ?? '', names).text;
  const rendered = renderBlocks(blocks, names);
  if (rendered === '') return { shown: fallback, fallback, mismatch: false };
  return { shown: rendered, fallback, mismatch: forComparison(rendered) !== forComparison(fallback) };
}
